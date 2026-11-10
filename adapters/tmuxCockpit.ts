/**
 * adapters/tmuxCockpit.ts
 *
 * The cockpit `orc start-session` opens: one tmux session in a per-user tmux
 * server of its own (never a project's private `orc-<hash>` server), with one
 * window (tab) per project. Each window's primary pane is a native nested
 * attach to that project's master (`attach-session` with input, as
 * `orc attach master --write`), so it keeps working while the coordinator
 * restarts or is down; the pane beside it runs `orc watch`.
 *
 * The server starts with no config file (`-f /dev/null`). It claims only its
 * keys (`resolveCockpitKeys`: a prefix, F12 by default, and a few direct
 * function keys), all of them layout-safe, and its tab keys run `orc cockpit`
 * (the tab model, lib/cockpitTabs.ts); every other key, Ctrl-b included,
 * reaches the focused pane. Mouse mode is on: a click focuses a pane or
 * selects a tab, and a pane whose program asks for the mouse still gets it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import {
  EMPTY_COCKPIT_STATE, MASTER_TAB, closedTabs, openAgent, parseTabs, reconcileTabs, selectProject, selectTab, serializeTabs, shownTab,
  type CockpitTabState, type OpenTab, type TabTransition,
} from '../lib/cockpitTabs.ts';
import { acquireLock, releaseLock } from '../lib/lock.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { shellQuote, tmuxBinary, tmuxSocketPath } from './tmux.ts';

/** The per-user cockpit server: tmux keeps it in the per-user 0700 socket directory. */
export const COCKPIT_SOCKET = 'orc-cockpit';
export const COCKPIT_SESSION = 'cockpit';

// ── Keys ─────────────────────────────────────────────────────────────────────
// Defaults are function keys: they need no Option/Alt/AltGr on any keyboard layout.

/** The direct keys' actions: `tab1`..`tab9` select that tab of the active project, `dashboard` focuses the dashboard pane, `attention` shows the next agent needing attention. */
export const COCKPIT_ACTIONS = ['tab1', 'tab2', 'tab3', 'tab4', 'tab5', 'tab6', 'tab7', 'tab8', 'tab9', 'dashboard', 'attention'] as const;
export type CockpitAction = typeof COCKPIT_ACTIONS[number];

export interface CockpitKeys {
  /** The tmux prefix: prefix + d/o as in tmux, n/p/&/1-9 for the active project's tabs, N/P for projects; pressed twice, it reaches the pane. */
  prefix: string;
  /** Keys bound without the prefix; null leaves the action to the prefix table only. */
  direct: Record<CockpitAction, string | null>;
}

export const DEFAULT_COCKPIT_KEYS: CockpitKeys = {
  prefix: 'F12',
  direct: {
    tab1: 'F1', tab2: 'F2', tab3: 'F3', tab4: 'F4', tab5: 'F5', tab6: 'F6', tab7: 'F7', tab8: 'F8', tab9: 'F9',
    dashboard: 'F10', attention: 'F11',
  },
};

/** The prefix cockpits had before the keys were configurable; a reattach unbinds it. */
const LEGACY_PREFIX = 'C-]';

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/i;
const NAMED_KEY = /^(F([1-9]|1[0-2])|Home|End|PageUp|PgUp|PPage|PageDown|PgDn|NPage|Insert|IC|Delete|DC|Up|Down|Left|Right|Tab|BTab|Space|Enter|Escape|BSpace)$/i;

/** Whether tmux knows `key`: optional C-/M-/S- modifiers, then a named key or one printable ASCII character. */
export function isTmuxKeyName(key: string): boolean {
  const base = key.replace(/^([CMS]-)+(?=.)/, '');
  return NAMED_KEY.test(base) || /^[!-~]$/.test(base);
}

/** A direct key is bound for every pane: unmodified, only a function key, so typing never reaches the cockpit by accident. */
function isDirectKeyName(key: string): boolean {
  return isTmuxKeyName(key) && (FUNCTION_KEY.test(key) || /^[CM]-/.test(key));
}

/**
 * The cockpit keys from `ORC_COCKPIT_PREFIX` (a tmux key name) and
 * `ORC_COCKPIT_KEYS` (`action=key` pairs, comma-separated; `none` unbinds a
 * direct key). Anything invalid is reported in `problems` and its default kept;
 * a direct key that clashes with the prefix or an earlier direct key is dropped.
 */
export function resolveCockpitKeys(env: NodeJS.ProcessEnv = process.env): { keys: CockpitKeys; problems: string[] } {
  const problems: string[] = [];
  let prefix = DEFAULT_COCKPIT_KEYS.prefix;
  const rawPrefix = env.ORC_COCKPIT_PREFIX?.trim();
  if (rawPrefix) {
    if (isTmuxKeyName(rawPrefix)) prefix = rawPrefix;
    else problems.push(`ORC_COCKPIT_PREFIX: unknown key '${rawPrefix}'; using ${prefix}`);
  }
  const direct = { ...DEFAULT_COCKPIT_KEYS.direct };
  for (const entry of (env.ORC_COCKPIT_KEYS ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const split = entry.indexOf('=');
    const action = entry.slice(0, split).trim();
    const key = entry.slice(split + 1).trim();
    if (split < 0 || !(COCKPIT_ACTIONS as readonly string[]).includes(action)) {
      problems.push(`ORC_COCKPIT_KEYS: unknown entry '${entry}' (expected <action>=<key>, actions: ${COCKPIT_ACTIONS.join(', ')})`);
      continue;
    }
    const name = action as CockpitAction;
    if (key.toLowerCase() === 'none') direct[name] = null;
    else if (isDirectKeyName(key)) direct[name] = key;
    else problems.push(`ORC_COCKPIT_KEYS: '${key}' cannot be the ${name} key (a function key F1-F12, or a C- or M- key); using ${direct[name] ?? 'none'}`);
  }
  const taken = new Set([prefix.toLowerCase()]);
  for (const action of COCKPIT_ACTIONS) {
    const key = direct[action];
    if (key == null) continue;
    if (taken.has(key.toLowerCase())) {
      problems.push(`ORC_COCKPIT_KEYS: ${key} is already the prefix or another action's key; ${action} has no direct key`);
      direct[action] = null;
    } else {
      taken.add(key.toLowerCase());
    }
  }
  return { keys: { prefix, direct }, problems };
}

/** How a tmux key name reads in a hint: `C-x` as `Ctrl-x`, `M-x` as `Alt-x`. */
function keyLabel(key: string): string {
  return key.replace(/^((?:[CMS]-)+)(?=.)/, (mods) => mods.replace(/C-/g, 'Ctrl-').replace(/M-/g, 'Alt-').replace(/S-/g, 'Shift-'));
}

/** How to get around, shown on attach and in the status line. */
export function cockpitKeysHint(keys: CockpitKeys): string {
  const prefix = keyLabel(keys.prefix);
  const tabs = COCKPIT_ACTIONS.slice(0, 9).map((action) => keys.direct[action]).filter((key): key is string => key != null);
  return [
    ...(tabs.length > 0 ? [`${tabs.length > 1 ? `${keyLabel(tabs[0])}-${keyLabel(tabs.at(-1)!)}` : keyLabel(tabs[0])}: tab`] : []),
    ...(keys.direct.dashboard ? [`${keyLabel(keys.direct.dashboard)}: dashboard`] : []),
    `${prefix} o: switch pane`,
    `${prefix} n/p: next/previous tab`,
    `${prefix} N/P: project`,
    `${prefix} d: detach`,
  ].join(' | ');
}

/**
 * A tmux `run-shell` command running `orc cockpit <args>` for the client that
 * pressed the key, which shows the outcome in its message line. `orc` is the
 * command that runs orc (node and its entry point).
 */
export function cockpitRunShell(orc: string[], args: string[]): string[] {
  // run-shell expands formats: a `#` in a path must reach the shell as itself.
  const command = [...orc, 'cockpit', ...args].map((part) => shellQuote(part).replace(/#/g, '##')).join(' ');
  return ['run-shell', `${command} --client='#{client_name}'`];
}

/** What a direct key does: `orc cockpit tab N` or `orc cockpit attention`, or focus the dashboard pane (the rightmost). */
function directKeyCommand(action: CockpitAction, orc: string[]): string[] {
  if (action.startsWith('tab')) return cockpitRunShell(orc, ['tab', action.slice(3)]);
  if (action === 'attention') return cockpitRunShell(orc, ['attention']);
  return ['select-pane', '-t', '{right}'];
}

/** The prefix-table keys `orc cockpit` handles: the active project's tabs (n/p, 1-9, & closes) and the projects (N/P). */
function prefixTabBindings(orc: string[]): string[][] {
  return [
    ['n', 'next'], ['p', 'prev'], ['&', 'close'], ['N', 'project next'], ['P', 'project prev'],
    ...Array.from({ length: 9 }, (_, index) => [String(index + 1), `tab ${index + 1}`]),
  ].map(([key, action]) => ['bind-key', key, ...cockpitRunShell(orc, action.split(' '))]);
}

/** Server options recording the keys orc bound, so a later reattach can unbind them first. */
const PREFIX_OPTION = '@orc_cockpit_prefix';
const DIRECT_OPTION = '@orc_cockpit_direct';

/** The keys an earlier cockpit bound; a cockpit from before configurable keys records none and used `C-]`. */
export interface BoundCockpitKeys { prefix: string; direct: string[] }

/**
 * The commands that set the cockpit's keys and mouse, unbinding what `bound`
 * says an earlier run bound: the prefix (and its send-prefix binding), the
 * direct keys in the root table, tabs numbered from 1 with no gaps, and the hint
 * in the status line.
 */
export function cockpitKeyOptions(keys: CockpitKeys, bound: BoundCockpitKeys | null, orc: string[]): string[][] {
  const hint = cockpitKeysHint(keys);
  const direct = COCKPIT_ACTIONS.flatMap((action) => {
    const key = keys.direct[action];
    return key ? [{ action, key }] : [];
  });
  return [
    ...(bound ? [['unbind-key', '-q', bound.prefix], ...bound.direct.map((key) => ['unbind-key', '-q', '-n', key])] : []),
    ['set-option', '-g', 'prefix', keys.prefix],
    ['set-option', '-g', 'prefix2', 'None'],
    ['unbind-key', '-q', 'C-b'],
    ['bind-key', keys.prefix, 'send-prefix'],
    ...direct.map(({ action, key }) => ['bind-key', '-n', key, ...directKeyCommand(action, orc)]),
    ...prefixTabBindings(orc),
    ['set-option', '-g', PREFIX_OPTION, keys.prefix],
    ['set-option', '-g', DIRECT_OPTION, direct.map(({ key }) => key).join(' ')],
    // A click focuses a pane or selects a tab; the default mouse bindings pass events on to a pane that asks for them.
    ['set-option', '-g', 'mouse', 'on'],
    // Tab N is window N: prefix 1-9 and the direct tab keys agree, and closing a tab closes the gap.
    ['set-option', '-g', 'base-index', '1'],
    ['set-option', '-g', 'renumber-windows', 'on'],
    ['set-option', '-g', 'status-left', '[orc] '],
    ['set-option', '-g', 'status-right', hint],
    ['set-option', '-g', 'status-right-length', String(hint.length + 2)],
  ];
}

/** The keys a running cockpit's server options record; `C-]` and no direct keys for one from before they did. */
function boundCockpitKeys(): BoundCockpitKeys {
  const show = (option: string) => cockpitTmux(['show-options', '-gqv', option]).stdout?.trim() ?? '';
  const prefix = show(PREFIX_OPTION);
  return { prefix: prefix || LEGACY_PREFIX, direct: show(DIRECT_OPTION).split(' ').filter(Boolean) };
}
/** The dashboard pane is a sidebar: a quarter of the window, kept within these columns (it is laid out for 40). */
const DASHBOARD_MIN_COLUMNS = 40;
const DASHBOARD_MAX_COLUMNS = 60;
/** The master stays the primary pane: the dashboard never takes more than this share of a narrow window. */
const DASHBOARD_MAX_SHARE = 0.4;
const DEFAULT_SIZE = { columns: 200, rows: 50 };
/** Window options naming what a window shows. Values never hold spaces, so list-windows output splits on them. */
const PROJECT_OPTION = '@orc_project_id';
const MASTER_OPTION = '@orc_master';
const MASTER_PANE_OPTION = '@orc_master_pane';

export interface CockpitMaster {
  agentId: string;
  /** The master's tmux socket (`-L`) and session, as `tmuxSessionTarget` resolves them. */
  socket: string;
  session: string;
}

export interface CockpitProject {
  id: string;
  name: string;
  /** Where the project's panes start. */
  root: string;
  /** The environment that selects the project for orc (ORC_PROJECT_ID, ORC_STATE_DIR). */
  env: Record<string, string>;
}

export interface CockpitOptions {
  /** The tmux binary the pane scripts run. */
  tmux: string;
  /** The terminal reports 24-bit colour (COLORTERM): tell both tmux layers so colours pass through unreduced. */
  trueColor: boolean;
}

/** Whether `COLORTERM` announces 24-bit colour. */
export function terminalHasTrueColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '');
}

/** Identifies the master a window attaches to; a different one (a replaced master) respawns the pane. */
export function masterKey(master: CockpitMaster): string {
  return `${master.socket}/${master.session}`;
}

/**
 * The master pane's script: attach to the master with input, and attach again
 * whenever the client returns. A client detached by the master's own Ctrl-b d
 * (exit 0) while the master runs detaches the cockpit client showing this pane
 * too, as a direct attach would; a failed attach keeps its error on screen and
 * retries after a pause. A master that is not running leaves a note and the
 * pane waits for it to start.
 */
export function masterPaneScript(master: CockpitMaster, project: Pick<CockpitProject, 'name'>, options: CockpitOptions): string {
  const tmux = shellQuote(options.tmux);
  const socket = shellQuote(master.socket);
  const session = shellQuote(`=${master.session}`);
  const note = [
    `Master '${master.agentId}' of ${project.name} is not running.`,
    'Run orc start-session for this project to start it; this pane attaches as soon as it runs.',
    'The cockpit, the workers and the coordinator keep running.',
  ].map(shellQuote).join(' ');
  return [
    // A nested tmux client refuses to start while TMUX names the cockpit; keep it to reach the cockpit client.
    'cockpit_tmux=$TMUX',
    'unset TMUX',
    "trap '' INT",
    `has() { ${tmux} -L ${socket} has-session -t ${session} 2>/dev/null; }`,
    'while :; do',
    '  if has; then',
    `    if ${tmux} ${options.trueColor ? '-T RGB ' : ''}-L ${socket} attach-session -t ${session}; then`,
    // With TMUX and TMUX_PANE naming this pane, detach-client picks the cockpit client that shows it.
    `      if has; then TMUX=$cockpit_tmux ${tmux} detach-client 2>/dev/null; sleep 1; fi`,
    '    else',
    `      printf '%s\n' ${shellQuote('Could not attach to the master; retrying in 5 s.')}`,
    '      sleep 5',
    '    fi',
    '  else',
    '    clear',
    `    printf '%s\\n' ${note}`,
    '    while ! has; do sleep 2; done',
    '  fi',
    'done',
  ].join('\n');
}

/**
 * The dashboard pane's script: `orc watch` for the project, restarted if it
 * exits. TMUX stays set: it is how `orc watch` knows it runs in the cockpit
 * (`insideCockpit`), so Enter opens agent tabs.
 */
export function dashboardPaneScript(project: Pick<CockpitProject, 'env'>, watchCommand: string[]): string {
  return [
    ...Object.entries(project.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    'while :; do',
    `  ${watchCommand.map(shellQuote).join(' ')}`,
    "  printf '\\n%s\\n' 'orc watch exited; restarting in 5 s.'",
    '  sleep 5',
    'done',
  ].join('\n');
}

/** Joins tmux commands into one command list (`a ; b`), run in order by one tmux invocation. */
function commandList(commands: string[][]): string[] {
  return commands.flatMap((command, index) => (index === 0 ? command : [';', ...command]));
}

/** The cockpit server's global options, set before its first session is created. */
export function cockpitServerOptions(options: { trueColor: boolean; terminal: string; keys: CockpitKeys; orc: string[] }): string[][] {
  return [
    // Esc reaches the provider CLI without tmux's default half-second wait.
    ['set-option', '-g', 'escape-time', '10'],
    ['set-option', '-g', 'default-terminal', options.terminal],
    ...(options.trueColor ? [['set-option', '-as', 'terminal-features', ',*:RGB']] : []),
    ...cockpitKeyOptions(options.keys, null, options.orc),
  ];
}

/**
 * The dashboard pane's width in a window `columns` wide: a quarter of it,
 * within 40–60 columns, and at most 40% of a narrow window so the master
 * stays the primary pane.
 */
export function dashboardPaneWidth(columns: number): number {
  const sidebar = Math.min(DASHBOARD_MAX_COLUMNS, Math.max(DASHBOARD_MIN_COLUMNS, Math.round(columns / 4)));
  return Math.max(1, Math.min(sidebar, Math.floor(columns * DASHBOARD_MAX_SHARE)));
}

/** The pane layout of a window `columns` wide just created with its master pane `paneId`: the dashboard beside it, the window labelled, the master focused. */
export function windowLayoutCommands(windowId: string, paneId: string, columns: number, project: CockpitProject, master: CockpitMaster, dashboardScript: string): string[][] {
  return [
    ['split-window', '-h', '-d', '-l', String(dashboardPaneWidth(columns)), '-t', paneId, '-c', project.root, '/bin/sh', '-c', dashboardScript],
    ['set-option', '-w', '-t', windowId, PROJECT_OPTION, project.id],
    ['set-option', '-w', '-t', windowId, MASTER_OPTION, masterKey(master)],
    ['set-option', '-w', '-t', windowId, MASTER_PANE_OPTION, paneId],
    ...focusCommands(windowId, paneId),
  ];
}

function focusCommands(windowId: string, paneId: string): string[][] {
  return [['select-window', '-t', windowId], ['select-pane', '-t', paneId]];
}

/** Names one project or one tmux client; the cockpit serves several, so each pane sets its own. */
const PER_PROJECT_ENV = ['TMUX', 'TMUX_PANE', 'ORC_PROJECT_ID', 'ORC_STATE_DIR', 'ORC_CONTROL_SOCKET', 'ORC_PROJECT_FLAG'];

/** The server's environment: no session secrets, no project selection and no outer tmux; other ORC_* settings stay. */
export function cockpitServerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const next = stripNestedProviderEnv(env);
  for (const key of PER_PROJECT_ENV) delete next[key];
  return next as Record<string, string>;
}

function cockpitTmux(args: string[]) {
  return spawnSync(tmuxBinary(), ['-L', COCKPIT_SOCKET, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: cockpitServerEnv(),
  });
}

function cockpitTmuxOrThrow(args: string[]): string {
  const result = cockpitTmux(args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tmux ${args[0]} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  return result.stdout;
}

/** `tmux-256color` where its terminfo entry exists, else the universally installed `screen-256color`. */
function cockpitTerminal(): string {
  const probe = spawnSync('infocmp', ['tmux-256color'], { stdio: 'ignore', timeout: 5_000 });
  return !probe.error && probe.status === 0 ? 'tmux-256color' : 'screen-256color';
}

interface CockpitWindow { windowId: string; projectId: string; master: string; masterPane: string; columns: number }

function cockpitWindows(): CockpitWindow[] {
  const out = cockpitTmuxOrThrow(['list-windows', '-t', `=${COCKPIT_SESSION}`, '-F',
    `#{window_id} #{${PROJECT_OPTION}} #{${MASTER_OPTION}} #{${MASTER_PANE_OPTION}} #{window_width}`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [windowId = '', projectId = '', master = '', masterPane = '', width = ''] = line.split(' ');
    return { windowId, projectId, master, masterPane, columns: windowColumns(width) };
  });
}

function windowPanes(windowId: string): string[] {
  return cockpitTmuxOrThrow(['list-panes', '-t', windowId, '-F', '#{pane_id}']).split('\n').filter(Boolean);
}

/** A `#{window_width}` value; the default width when tmux printed none. */
function windowColumns(width: string | undefined): number {
  const columns = Number(width);
  return Number.isInteger(columns) && columns > 0 ? columns : DEFAULT_SIZE.columns;
}

function parseCreated(out: string): { windowId: string; paneId: string; columns: number } {
  const [windowId, paneId, width] = out.trim().split(' ');
  if (!windowId?.startsWith('@') || !paneId?.startsWith('%')) throw new Error(`unexpected tmux output '${out.trim()}'`);
  return { windowId, paneId, columns: windowColumns(width) };
}

export type CockpitWindowOutcome = 'created-session' | 'created-window' | 'respawned-master' | 'existing';

/**
 * Creates the cockpit (or reuses it) and makes sure it has a window for
 * `project` whose master pane attaches to `master`, then focuses that pane.
 * Idempotent: an existing window for the project is reused; one whose master
 * changed has its master pane respawned; one whose master pane is gone is rebuilt.
 */
export function ensureCockpitWindow(spec: {
  project: CockpitProject;
  master: CockpitMaster;
  watchCommand: string[];
  /** The command that runs orc (node and its entry point): the cockpit keys run `orc cockpit` with it. */
  orc: string[];
  options: CockpitOptions;
  keys: CockpitKeys;
  size?: { columns?: number; rows?: number };
}): CockpitWindowOutcome {
  const { project, master, options } = spec;
  const masterCommand = ['/bin/sh', '-c', masterPaneScript(master, project, options)];
  const dashboardScript = dashboardPaneScript(project, spec.watchCommand);
  const newPane = ['-n', project.name, '-c', project.root, '-P', '-F', '#{window_id} #{pane_id} #{window_width}', ...masterCommand];

  const hasCockpit = () => cockpitTmux(['has-session', '-t', `=${COCKPIT_SESSION}`]).status === 0;
  if (!hasCockpit()) {
    const columns = spec.size?.columns || DEFAULT_SIZE.columns;
    const rows = spec.size?.rows || DEFAULT_SIZE.rows;
    const created = cockpitTmux(commandList([
      ...cockpitServerOptions({ trueColor: options.trueColor, terminal: cockpitTerminal(), keys: spec.keys, orc: spec.orc }),
      ['new-session', '-d', '-s', COCKPIT_SESSION, '-x', String(columns), '-y', String(rows), ...newPane],
    ]));
    if (!created.error && created.status === 0) {
      const { windowId, paneId, columns: width } = parseCreated(created.stdout);
      cockpitTmuxOrThrow(commandList(windowLayoutCommands(windowId, paneId, width, project, master, dashboardScript)));
      return 'created-session';
    }
    // Another start-session created the cockpit first: add this project's tab to it.
    if (!hasCockpit()) throw created.error ?? new Error(`tmux new-session failed: ${(created.stderr || '').trim() || `exit ${created.status}`}`);
  }
  // A running cockpit, maybe created with other keys (or before they were configurable): apply these, and number its tabs from 1.
  cockpitTmuxOrThrow(commandList([...cockpitKeyOptions(spec.keys, boundCockpitKeys(), spec.orc), ['move-window', '-r', '-t', `=${COCKPIT_SESSION}`]]));

  const existing = cockpitWindows().find((window) => window.projectId === project.id);
  if (existing) {
    const panes = windowPanes(existing.windowId);
    if (panes.includes(existing.masterPane)) {
      if (panes.length < 2) {
        // The dashboard pane was closed: rebuild the layout around the master pane.
        cockpitTmuxOrThrow(commandList(windowLayoutCommands(existing.windowId, existing.masterPane, existing.columns, project, master, dashboardScript)));
      }
      if (existing.master === masterKey(master)) {
        cockpitTmuxOrThrow(commandList(focusCommands(existing.windowId, existing.masterPane)));
        return 'existing';
      }
      cockpitTmuxOrThrow(commandList([
        ['respawn-pane', '-k', '-t', existing.masterPane, '-c', project.root, ...masterCommand],
        ['set-option', '-w', '-t', existing.windowId, MASTER_OPTION, masterKey(master)],
        ...focusCommands(existing.windowId, existing.masterPane),
      ]));
      return 'respawned-master';
    }
    cockpitTmuxOrThrow(['kill-window', '-t', existing.windowId]);
  }
  const { windowId, paneId, columns } = parseCreated(cockpitTmuxOrThrow(['new-window', '-d', '-t', `=${COCKPIT_SESSION}:`, ...newPane]));
  cockpitTmuxOrThrow(commandList(windowLayoutCommands(windowId, paneId, columns, project, master, dashboardScript)));
  return 'created-window';
}

/** The command that attaches this terminal to the cockpit. */
export function cockpitAttachCommand(): { command: string; args: string[] } {
  return { command: tmuxBinary(), args: ['-L', COCKPIT_SOCKET, '-f', '/dev/null', 'attach-session', '-t', `=${COCKPIT_SESSION}`] };
}

/** Whether `TMUX` says this process already runs inside the cockpit (a shell in one of its windows). */
export function insideCockpit(env: NodeJS.ProcessEnv = process.env): boolean {
  const socket = env.TMUX?.split(',')[0];
  return !!socket && socket === tmuxSocketPath(COCKPIT_SOCKET);
}

// ── Agent tabs ───────────────────────────────────────────────────────────────
// A worker's or scout's live terminal opens in a tab of its own, next to its
// project's tab: `orc terminal <agent_id> --write`, a control-API stream, so
// opening it never attaches a tmux client to the agent's server (no resize on
// attach; only the lease holder sizes the pane, as docs/terminal-streaming.md says).

/** Window options naming the agent a tab streams. */
const AGENT_PROJECT_OPTION = '@orc_agent_project';
const AGENT_ID_OPTION = '@orc_agent_id';

export interface CockpitAgentTab {
  projectId: string;
  projectName: string;
  agentId: string;
  /** Where the tab's shell starts. */
  root: string;
  /** What the tab runs: `orc terminal <agent_id> --write` for the agent's project. */
  command: string[];
  /** The environment that selects the project for orc; ORC_* inherited from elsewhere is unset first. */
  env: Record<string, string>;
}

/** Ids `orc watch` gives a state directory no registered project owns: `unregistered:<state dir>`. */
export const UNREGISTERED_PROJECT_PREFIX = 'unregistered:';

/** The project an agent tab belongs to, as the project list describes it. */
export interface CockpitTabProject { project_id: string; name: string; state_dir: string; target_repo_root: string }

/**
 * The tab of `agentId`'s live terminal: `orc terminal <agent_id> --write` for
 * its project (`--project=<id>`, or `ORC_STATE_DIR` for an unregistered one).
 */
export function cockpitAgentTab(agentId: string, project: CockpitTabProject, orc: string[]): CockpitAgentTab {
  const unregistered = project.project_id.startsWith(UNREGISTERED_PROJECT_PREFIX);
  return {
    projectId: project.project_id,
    projectName: project.name,
    agentId,
    root: project.target_repo_root,
    command: [...orc, 'terminal', agentId, '--write', ...(unregistered ? [] : [`--project=${project.project_id}`])],
    env: unregistered ? { ORC_STATE_DIR: project.state_dir } : {},
  };
}

/** An agent tab's window name: `<project>/<agent_id>`. Tabs are found by their window options, never by name. */
export function agentWindowName(projectName: string, agentId: string): string {
  return `${projectName}/${agentId}`;
}

/**
 * An agent tab's script: run the stream; when it ends (the agent's session
 * ended, the stream fell behind, or its own Ctrl-] detached it), say so and wait:
 * Enter closes the tab, `r` reconnects. Closing the tab only ends the stream;
 * the agent's session keeps running.
 */
export function agentTabScript(tab: Pick<CockpitAgentTab, 'agentId' | 'projectName' | 'command' | 'env'>): string {
  const ended = `The terminal of ${tab.agentId} (${tab.projectName}) is closed`;
  return [
    `unset TMUX ${PER_PROJECT_ENV.filter((key) => key.startsWith('ORC_')).join(' ')}`,
    ...Object.entries(tab.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    'while :; do',
    '  clear',
    `  ${tab.command.map(shellQuote).join(' ')}`,
    '  code=$?',
    `  printf '\\n%s (exit %s).\\n%s\\n' ${shellQuote(ended)} "$code" ${shellQuote('Closing this tab never stops the agent. Enter: close the tab · r Enter: reconnect')}`,
    '  read -r answer || exit 0',
    '  [ "$answer" = r ] || exit 0',
    'done',
  ].join('\n');
}

export interface CockpitTabWindow {
  windowId: string;
  /** The project tab's project (`@orc_project_id`), empty on an agent tab. */
  projectId: string;
  /** The agent tab's project and agent, empty on a project tab. */
  agentProjectId: string;
  agentId: string;
}

export type AgentTabPlan =
  | { action: 'switch'; windowId: string }
  /** `after`: the window to insert the new tab after (the project's last tab), null to append. */
  | { action: 'open'; after: string | null };

/** Open-vs-switch: the agent's existing tab, else a new one after its project's last tab (windows in index order). */
export function planAgentTab(windows: CockpitTabWindow[], projectId: string, agentId: string): AgentTabPlan {
  const existing = windows.find((window) => window.agentProjectId === projectId && window.agentId === agentId);
  if (existing) return { action: 'switch', windowId: existing.windowId };
  const own = windows.filter((window) => window.projectId === projectId || window.agentProjectId === projectId);
  return { action: 'open', after: own.at(-1)?.windowId ?? null };
}

interface TabWindow extends CockpitTabWindow {
  /** The cockpit's current window. */
  active: boolean;
  /** A project tab's master pane (`@orc_master_pane`), empty on an agent tab. */
  masterPane: string;
}

function tabWindows(): TabWindow[] {
  // tmux prints a tab in a format as `_`, so fields split on spaces; the project id goes last because an
  // unregistered one is a path, which may hold spaces. A window has either a project or an agent's project.
  const out = cockpitTmuxOrThrow(['list-windows', '-t', `=${COCKPIT_SESSION}`, '-F',
    `#{window_id} #{window_active} [#{${MASTER_PANE_OPTION}}] [#{${AGENT_ID_OPTION}}] #{${PROJECT_OPTION}}#{${AGENT_PROJECT_OPTION}}`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const match = /^(\S+) (\d) \[(\S*)\] \[(\S*)\] (.*)$/.exec(line);
    const [, windowId = '', active = '', masterPane = '', agentId = '', project = ''] = match ?? [];
    return agentId
      ? { windowId, active: active === '1', masterPane: '', projectId: '', agentProjectId: project, agentId }
      : { windowId, active: active === '1', masterPane, projectId: project, agentProjectId: '', agentId: '' };
  });
}

/** The tab a window shows; null for a window that is no orc tab. */
function windowTab(window: CockpitTabWindow): OpenTab | null {
  if (window.agentId) return window.agentProjectId ? { projectId: window.agentProjectId, agentId: window.agentId } : null;
  return window.projectId ? { projectId: window.projectId, agentId: null } : null;
}

function findTabWindow(windows: TabWindow[], tab: OpenTab): TabWindow | undefined {
  return windows.find((window) => {
    const shown = windowTab(window);
    return shown?.projectId === tab.projectId && shown.agentId === tab.agentId;
  });
}

// ── Tab state ────────────────────────────────────────────────────────────────
// The view state (lib/cockpitTabs.ts) lives in a server option, so key
// bindings, the dashboard and a reattach all read the same one. Every
// read-modify-write holds a lock file beside the cockpit's socket.

/** The server option holding the serialized tab state. */
const TABS_OPTION = '@orc_cockpit_tabs';
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

/** The lock serializing state updates: next to the cockpit's socket, in tmux's per-user 0700 directory. */
export function cockpitLockPath(): string {
  return `${tmuxSocketPath(COCKPIT_SOCKET)}.lock`;
}

function lockHolderDead(path: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
    process.kill(pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Runs `fn` holding the cockpit lock; waits up to 5 s for another holder, and breaks the lock of a holder that died. */
export function withCockpitLock<T>(fn: () => T, path = cockpitLockPath()): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      acquireLock(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error;
      if (lockHolderDead(path)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`another cockpit action is still running (${(error as Error).message})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    releaseLock(path);
  }
}

/** The open windows, and the stored state kept in step with them (rebuilt from them when missing or corrupt). */
function currentTabs(): { windows: TabWindow[]; state: CockpitTabState } {
  const windows = tabWindows();
  const open = windows.map(windowTab).filter((tab): tab is OpenTab => tab !== null);
  const current = windows.find((window) => window.active);
  const stored = parseTabs(cockpitTmux(['show-options', '-gqv', TABS_OPTION]).stdout?.trim()) ?? EMPTY_COCKPIT_STATE;
  return { windows, state: reconcileTabs(stored, open, current ? windowTab(current) : null) };
}

/** Resolves the agent tab to open when the shown tab has no window yet. */
export type AgentTabResolver = (projectId: string, agentId: string) => CockpitAgentTab;

export type CockpitActionResult = TabTransition & {
  /** A new agent tab window was opened. */
  opened: boolean;
};

/** Opens an agent tab's window after its project's last tab, without selecting it. */
function openAgentWindow(windows: TabWindow[], tab: CockpitAgentTab): string {
  const plan = planAgentTab(windows, tab.projectId, tab.agentId);
  const after = plan.action === 'open' ? plan.after : plan.windowId;
  const where = after ? ['-a', '-t', after] : ['-t', `=${COCKPIT_SESSION}:`];
  const windowId = cockpitTmuxOrThrow(['new-window', '-d', ...where, '-n', agentWindowName(tab.projectName, tab.agentId),
    '-c', tab.root, '-P', '-F', '#{window_id}', '/bin/sh', '-c', agentTabScript(tab)]).trim();
  if (!windowId.startsWith('@')) throw new Error(`unexpected tmux output '${windowId}'`);
  cockpitTmuxOrThrow(commandList([
    ['set-option', '-w', '-t', windowId, AGENT_PROJECT_OPTION, tab.projectId],
    ['set-option', '-w', '-t', windowId, AGENT_ID_OPTION, tab.agentId],
  ]));
  return windowId;
}

/**
 * Applies one transition to the cockpit, serialized with every other: reads
 * the stored state (rebuilt from the open windows when missing or corrupt, and
 * kept in step with them), applies `transition`, closes the windows of closed
 * tabs and shows the active tab (opening its window through `resolveAgentTab`
 * when it has none), then stores the state. A refused transition changes no
 * window. Closing a tab only ends its window's stream: no master, worker or
 * coordinator is stopped.
 */
export function applyCockpitTransition(
  transition: (state: CockpitTabState) => TabTransition,
  resolveAgentTab: AgentTabResolver = (projectId, agentId) => {
    throw new Error(`cannot open a tab for ${agentId} (${projectId}) here`);
  },
): CockpitActionResult {
  return withCockpitLock(() => {
    const { windows, state } = currentTabs();
    const store = (next: CockpitTabState) => cockpitTmuxOrThrow(['set-option', '-g', TABS_OPTION, serializeTabs(next)]);

    let result: TabTransition = transition(state);
    let opened = false;
    const shown = result.ok ? shownTab(result.state) : null;
    if (shown && shown.agentId === null && !findTabWindow(windows, shown)) {
      result = { ok: false, state, message: `${shown.projectId} has no master tab in the cockpit; run orc start-session in it.` };
    }
    if (!result.ok) {
      store(state);
      return { ...result, state, opened };
    }
    if (shown) {
      const existing = findTabWindow(windows, shown);
      if (existing) {
        cockpitTmuxOrThrow(commandList(existing.masterPane
          ? focusCommands(existing.windowId, existing.masterPane)
          : [['select-window', '-t', existing.windowId]]));
      } else {
        const windowId = openAgentWindow(windows, resolveAgentTab(shown.projectId, shown.agentId!));
        cockpitTmuxOrThrow(['select-window', '-t', windowId]);
        opened = true;
      }
    }
    for (const closed of closedTabs(state, result.state)) {
      const window = findTabWindow(windows, closed);
      if (window) cockpitTmuxOrThrow(['kill-window', '-t', window.windowId]);
    }
    store(result.state);
    return { ...result, opened };
  });
}

/** The stored tab state, kept in step with the open windows; read-only. */
export function readCockpitTabs(): CockpitTabState {
  return currentTabs().state;
}

/** Whether the cockpit session runs. */
export function cockpitRunning(): boolean {
  return cockpitTmux(['has-session', '-t', `=${COCKPIT_SESSION}`]).status === 0;
}

/** Shows `text` in `client`'s message line (a key binding's outcome). */
export function cockpitMessage(client: string, text: string): void {
  cockpitTmux(['display-message', '-c', client, text.replace(/#/g, '##')]);
}

/**
 * Switches the cockpit to `tab`'s agent tab, opening it first when the agent
 * has none (so one tab, and one stream, per agent).
 */
export function openAgentTab(tab: CockpitAgentTab): 'opened' | 'switched' {
  const result = applyCockpitTransition((state) => openAgent(state, tab.projectId, tab.agentId), () => tab);
  if (!result.ok) throw new Error(result.message);
  return result.opened ? 'opened' : 'switched';
}

/** Switches the cockpit to `projectId`'s master tab; false when the project has no tab. */
export function switchToMasterTab(projectId: string): boolean {
  return applyCockpitTransition((state) => {
    const selected = selectProject(state, projectId);
    return selected.ok ? selectTab(selected.state, MASTER_TAB) : selected;
  }).ok;
}
