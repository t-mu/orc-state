/**
 * adapters/tmuxCockpit.ts
 *
 * The cockpit `orc start-session` opens: one tmux session in a per-user tmux
 * server of its own (never a project's private `orc-<hash>` server), shown as
 * one window, the frame: the sidebar (left, full height, the `orc watch`
 * dashboard), the tab bar (top right, `orc cockpit bar`) and the slot (bottom
 * right) showing the active project's active tab. Each tab's process lives in
 * a pane of its project's hidden holding window and is swapped into the slot
 * when its tab is shown, so switching is instant and streams stay open. A
 * project's master tab is a native nested attach to its master
 * (`attach-session` with input, as `orc attach master --write`), so it keeps
 * working while the coordinator restarts or is down; an agent tab runs
 * `orc terminal <agent_id> --write`.
 *
 * The server starts with no config file (`-f /dev/null`). It claims only its
 * keys (`resolveCockpitKeys`: a prefix, F12 by default, and a few direct
 * function keys), all of them layout-safe, and its tab keys run `orc cockpit`
 * (the tab model, lib/cockpitTabs.ts); every other key, Ctrl-b included,
 * reaches the focused pane. Mouse mode is on: a click focuses a pane, and a
 * pane whose program asks for the mouse still gets it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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

/** The direct keys' actions: `tab1`..`tab9` select that tab of the active project, `dashboard` focuses the sidebar (the dashboard), `attention` shows the next agent needing attention. */
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

/** What a direct key does: `orc cockpit tab N` or `orc cockpit attention`, or focus the sidebar (the frame's leftmost pane). */
function directKeyCommand(action: CockpitAction, orc: string[]): string[] {
  if (action.startsWith('tab')) return cockpitRunShell(orc, ['tab', action.slice(3)]);
  if (action === 'attention') return cockpitRunShell(orc, ['attention']);
  return ['select-pane', '-t', '{left}'];
}

/** The prefix-table keys `orc cockpit` handles: the active project's tabs (n/p, 1-9, & closes) and the projects (N/P). */
function prefixTabBindings(orc: string[]): string[][] {
  return [
    ['n', 'next'], ['p', 'prev'], ['&', 'close'], ['N', 'project next'], ['P', 'project prev'], ['t', 'tasks'],
    ...Array.from({ length: 9 }, (_, index) => [String(index + 1), `tab ${index + 1}`]),
  ].map(([key, action]) => ['bind-key', key, ...cockpitRunShell(orc, action.split(' '))]);
}

/** A window's status-line entry: none for a holding window. */
const HIDE_HOLDING_FORMAT = '#{?#{@orc_holding},,#I:#W#F }';

/** Server options recording the keys orc bound, so a later reattach can unbind them first. */
const PREFIX_OPTION = '@orc_cockpit_prefix';
const DIRECT_OPTION = '@orc_cockpit_direct';

/** The keys an earlier cockpit bound; a cockpit from before configurable keys records none and used `C-]`. */
export interface BoundCockpitKeys { prefix: string; direct: string[] }

/**
 * The commands that set the cockpit's keys and mouse, unbinding what `bound`
 * says an earlier run bound: the prefix (and its send-prefix binding), the
 * direct keys in the root table, windows numbered from 1 with no gaps, holding
 * windows left out of the status line, and the hint in it.
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
    // A click focuses a pane; the default mouse bindings pass events on to a pane that asks for them.
    ['set-option', '-g', 'mouse', 'on'],
    // Windows are numbered from 1 with no gaps: the frame, then the holding windows.
    ['set-option', '-g', 'base-index', '1'],
    ['set-option', '-g', 'renumber-windows', 'on'],
    ['set-option', '-g', 'status-left', '[orc] '],
    // Holding windows are not listed: the frame is the only window shown.
    ['set-option', '-g', 'window-status-separator', ''],
    ['set-option', '-g', 'window-status-format', HIDE_HOLDING_FORMAT],
    ['set-option', '-g', 'window-status-current-format', HIDE_HOLDING_FORMAT],
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

// ── Frame ────────────────────────────────────────────────────────────────────
// The cockpit shows one window, the frame: the sidebar (left, full height), the
// tab bar (top right) and the slot (bottom right). Every tab is a pane of its
// project's hidden holding window; showing a tab swaps its pane into the slot,
// so its process, and its stream, never restarts.

/** The sidebar's width and the tab bar's height; a window-resized hook keeps them. */
export const SIDEBAR_COLUMNS = 34;
export const TAB_BAR_ROWS = 3;
const DEFAULT_SIZE = { columns: 200, rows: 50 };
const FRAME_NAME = 'orc';

/** Window options: the frame (`1`), and a holding window's project id. */
const FRAME_OPTION = '@orc_frame';
const HOLDING_OPTION = '@orc_holding';
/** Pane options, which move with a pane when it is swapped: what it is and, on a tab's pane, whose tab. */
const ROLE_OPTION = '@orc_role';
const TAB_PROJECT_OPTION = '@orc_tab_project';
const TAB_AGENT_OPTION = '@orc_tab_agent';
const MASTER_KEY_OPTION = '@orc_master_key';

/**
 * What a cockpit pane is. The frame's `sidebar` and `tabbar`; `placeholder`
 * fills an empty slot; `keeper` keeps a holding window alive while all its
 * tabs are shown elsewhere; a tab is a project's `master`, its `message` (the
 * project is not running), or an `agent`'s terminal. The `explorer` is the task
 * explorer, not a tab: it exists only while it is shown in the slot, and any
 * transition that takes it out of the slot kills it.
 */
export type CockpitPaneRole = 'sidebar' | 'tabbar' | 'placeholder' | 'keeper' | 'master' | 'message' | 'agent' | 'explorer';

/** Window options of the layout before the frame: one window per project and per agent tab. */
const LEGACY_PROJECT_OPTION = '@orc_project_id';
const LEGACY_MASTER_OPTION = '@orc_master';
const LEGACY_MASTER_PANE_OPTION = '@orc_master_pane';
const LEGACY_AGENT_PROJECT_OPTION = '@orc_agent_project';
const LEGACY_AGENT_ID_OPTION = '@orc_agent_id';

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

/** Identifies the master a pane attaches to; a different one (a replaced master) respawns the pane. */
export function masterKey(master: CockpitMaster): string {
  return `${master.socket}/${master.session}`;
}

/** The command that starts a project, as the cockpit tells it: it never starts one itself. */
export function startCommand(root: string): string {
  return `cd ${shellQuote(root)} && orc start-session`;
}

/** Waits until the pane is closed, ignoring Ctrl-C; a trap (a redraw on resize) runs while it waits. */
const WAIT_FOREVER = ["trap '' INT", 'while :; do sleep 3600 & wait $!; done'];

/**
 * A pane script that shows `lines` until the pane is closed, drawn again
 * whenever the pane is resized: a pane swapped from a small holding window
 * into the slot would otherwise keep the lines that scrolled away.
 */
function textPaneScript(lines: string[]): string {
  return [`show() { clear; printf '%s\\n' ${lines.map(shellQuote).join(' ')}; }`, 'show', 'trap show WINCH', ...WAIT_FOREVER].join('\n');
}

/**
 * The master pane's script: attach to the master with input, and attach again
 * whenever the client returns. A client detached by the master's own Ctrl-b d
 * (exit 0) while the master runs detaches the cockpit client showing this pane
 * too, as a direct attach would; a failed attach keeps its error on screen and
 * retries after a pause. A master that is not running leaves a note with the
 * command that starts it, and the pane waits for it to start.
 */
export function masterPaneScript(master: CockpitMaster, project: Pick<CockpitProject, 'name' | 'root'>, options: CockpitOptions): string {
  const tmux = shellQuote(options.tmux);
  const socket = shellQuote(master.socket);
  const session = shellQuote(`=${master.session}`);
  const note = [
    `Master '${master.agentId}' of ${project.name} is not running.`,
    `Start it: ${startCommand(project.root)}`,
    'This pane attaches as soon as it runs. The cockpit, the workers and the coordinator keep running.',
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
    `    note() { clear; printf '%s\\n' ${note}; }`,
    '    note',
    // Drawn again on resize: the pane may have been small in its holding window.
    '    trap note WINCH',
    '    while ! has; do sleep 2 & wait $!; done',
    "    trap - WINCH",
    '  fi',
    'done',
  ].join('\n');
}

/** The project a message pane stands in for: one in the cockpit's view that is not running there. */
export interface CockpitStoppedProject { projectId: string; projectName: string; root: string }

/**
 * A stopped project's pane, shown in its master's place: the command that
 * starts it. Nothing is started; `orc start-session` there replaces the pane
 * with the master.
 */
export function messagePaneScript(project: Pick<CockpitStoppedProject, 'projectName' | 'root'>): string {
  const lines = [
    `${project.projectName} is not running in the cockpit.`,
    '',
    'Start it from a terminal; the cockpit starts nothing itself:',
    `  ${startCommand(project.root)}`,
    '',
    'Its master then shows here.',
  ];
  return textPaneScript(lines);
}

/** A holding window's first pane: it keeps the window while every tab of the project is shown or closed. */
export function keeperPaneScript(): string {
  return WAIT_FOREVER.join('\n');
}

/** What an empty slot shows until a tab is swapped in. */
export function placeholderPaneScript(): string {
  return textPaneScript(['No tab is shown.']);
}

/**
 * The sidebar's script: `orc watch` for the project, restarted if it exits.
 * TMUX stays set: it is how `orc watch` knows it runs in the cockpit
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

/** The tab bar's script: `orc cockpit bar`, a text view of the tab state, restarted if it exits. */
export function tabBarPaneScript(orc: string[]): string {
  return [
    'while :; do',
    `  ${[...orc, 'cockpit', 'bar'].map(shellQuote).join(' ')}`,
    '  sleep 2',
    'done',
  ].join('\n');
}

/**
 * The explorer pane's script: `orc cockpit explorer <project_id>` until it
 * closes (Esc or q), then `orc cockpit tasks close` run by the cockpit server,
 * which swaps the active tab back into the slot and kills this pane. The
 * explorer runs with TMUX kept, so it knows it is in the cockpit.
 */
export function explorerPaneScript(orc: string[], projectId: string, tmux: string): string {
  const close = [...orc, 'cockpit', 'tasks', 'close'].map((part) => shellQuote(part).replace(/#/g, '##')).join(' ');
  return [
    'cockpit_tmux=$TMUX',
    `unset ${PER_PROJECT_ENV.filter((key) => key.startsWith('ORC_')).join(' ')}`,
    `${[...orc, 'cockpit', 'explorer', projectId].map(shellQuote).join(' ')}`,
    `TMUX=$cockpit_tmux ${shellQuote(tmux)} run-shell -b ${shellQuote(close)} 2>/dev/null || exit 0`,
    'sleep 5',
    'exit 0',
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

/** The commands that give the sidebar its width and the tab bar its height. */
export function frameSizeCommands(sidebar: string, tabbar: string): string[][] {
  return [['resize-pane', '-t', sidebar, '-x', String(SIDEBAR_COLUMNS)], ['resize-pane', '-t', tabbar, '-y', String(TAB_BAR_ROWS)]];
}

/** The hook that restores those sizes whenever the frame is resized (the terminal resized, a client of another size attached). */
export function frameResizeHook(windowId: string, sidebar: string, tabbar: string): string[] {
  const restore = frameSizeCommands(sidebar, tabbar).map((command) => command.join(' ')).join(' ; ');
  return ['set-hook', '-w', '-t', windowId, 'window-resized', restore];
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

// ── Panes ────────────────────────────────────────────────────────────────────

/** A pane of the cockpit session, with what its options say about it. */
export interface CockpitPane {
  paneId: string;
  windowId: string;
  windowName: string;
  /** The pane's window is the frame. */
  inFrame: boolean;
  /** The project whose holding window the pane is in; empty elsewhere. */
  holding: string;
  role: CockpitPaneRole | '';
  /** A tab pane's project and agent (empty on a master or message pane); on the sidebar, the project its dashboard runs for. */
  projectId: string;
  agentId: string;
  /** A master pane's `masterKey`. */
  masterKey: string;
  columns: number;
  rows: number;
}

/**
 * Separates the fields of a format: an unregistered project's id is a path,
 * which may hold spaces, and tmux prints a tab in a format as `_`.
 */
const FIELD_SEPARATOR = '<|>';

const PANE_FORMAT = [
  '#{pane_id}', '#{window_id}', '#{window_name}', `#{${FRAME_OPTION}}`, `#{${ROLE_OPTION}}`, `#{${TAB_AGENT_OPTION}}`, `#{${MASTER_KEY_OPTION}}`, '#{pane_width}x#{pane_height}',
  `#{${TAB_PROJECT_OPTION}}`, `#{${HOLDING_OPTION}}`,
].join(FIELD_SEPARATOR);

/** `list-panes -s` output in its format: fields joined with `<|>`. */
export function parseCockpitPanes(out: string): CockpitPane[] {
  return out.split('\n').filter(Boolean).map((line) => {
    const [paneId = '', windowId = '', windowName = '', frame = '', role = '', agentId = '', key = '', size = '', projectId = '', holding = ''] = line.split(FIELD_SEPARATOR);
    const [columns = 0, rows = 0] = size.split('x').map(Number);
    return { paneId, windowId, windowName, inFrame: frame === '1', holding, role: role as CockpitPaneRole | '', projectId, agentId, masterKey: key, columns, rows };
  });
}

function cockpitPanes(): CockpitPane[] {
  return parseCockpitPanes(cockpitTmuxOrThrow(['list-panes', '-s', '-t', `=${COCKPIT_SESSION}`, '-F', PANE_FORMAT]));
}

/** The tab a pane shows; null for a pane that is no tab. */
export function paneTab(pane: CockpitPane): OpenTab | null {
  if (!pane.projectId) return null;
  if (pane.role === 'master' || pane.role === 'message') return { projectId: pane.projectId, agentId: null };
  if (pane.role === 'agent' && pane.agentId) return { projectId: pane.projectId, agentId: pane.agentId };
  return null;
}

function findTabPane(panes: CockpitPane[], tab: OpenTab): CockpitPane | undefined {
  return panes.find((pane) => {
    const shown = paneTab(pane);
    return shown?.projectId === tab.projectId && shown.agentId === tab.agentId;
  });
}

export interface CockpitFrame {
  windowId: string;
  sidebar: string | null;
  tabbar: string | null;
  /** The pane in the slot; null when the slot was closed. */
  slot: CockpitPane | null;
}

/** The frame as its panes show it; null when the session has none. */
export function frameOf(panes: CockpitPane[]): CockpitFrame | null {
  const own = panes.filter((pane) => pane.inFrame);
  if (own.length === 0) return null;
  const windowId = own[0].windowId;
  const inWindow = own.filter((pane) => pane.windowId === windowId);
  return {
    windowId,
    sidebar: inWindow.find((pane) => pane.role === 'sidebar')?.paneId ?? null,
    tabbar: inWindow.find((pane) => pane.role === 'tabbar')?.paneId ?? null,
    slot: inWindow.find((pane) => pane.role !== 'sidebar' && pane.role !== 'tabbar') ?? null,
  };
}

/**
 * The commands that show `target` (a pane of a holding window) in the slot:
 * swap it with the slot's pane, which lands in `target`'s place; a tab of
 * another project then moves on to its own holding window (`holdingWindow`),
 * and a placeholder is closed. The frame stays current, the shown pane focused.
 * The holding windows are fitted afterwards (`holdingFitCommands`).
 */
export function slotCommands(frame: CockpitFrame & { slot: CockpitPane }, target: CockpitPane, holdingWindow: (projectId: string) => string | null): string[][] {
  const focus = [['select-window', '-t', frame.windowId], ['select-pane', '-t', target.paneId]];
  const { slot } = frame;
  if (slot.paneId === target.paneId) return focus;
  const commands = [['swap-pane', '-d', '-s', target.paneId, '-t', slot.paneId]];
  if (slot.role === 'placeholder') {
    commands.push(['kill-pane', '-t', slot.paneId]);
  } else if (paneTab(slot)) {
    const home = holdingWindow(slot.projectId);
    if (home && home !== target.windowId) commands.push(['join-pane', '-d', '-s', slot.paneId, '-t', home]);
  }
  return [...commands, ...focus];
}

/**
 * The commands that give every pane of a holding window the slot's size
 * (`columns` x `rows`): the window is sized by hand to fit its `panes` stacked
 * at that size. A hidden tab then keeps the size it has when shown, so parking
 * or showing it never resizes its agent's or master's window.
 */
export function holdingFitCommands(windowId: string, panes: number, columns: number, rows: number): string[][] {
  return [
    ['set-option', '-w', '-t', windowId, 'window-size', 'manual'],
    ['resize-window', '-t', windowId, '-x', String(columns), '-y', String(panes * rows + panes - 1)],
    ['select-layout', '-t', windowId, 'even-vertical'],
  ];
}

/** Fits every holding window to the slot's current size. */
function fitHoldingWindows(): void {
  const panes = cockpitPanes();
  const slot = frameOf(panes)?.slot;
  if (!slot || slot.columns < 1 || slot.rows < 1) return;
  const counts = new Map<string, number>();
  for (const pane of panes) if (pane.holding && !pane.inFrame) counts.set(pane.windowId, (counts.get(pane.windowId) ?? 0) + 1);
  const commands = [...counts].flatMap(([windowId, count]) => holdingFitCommands(windowId, count, slot.columns, slot.rows));
  if (commands.length > 0) cockpitTmuxOrThrow(commandList(commands));
}

function holdingWindows(): Map<string, string> {
  const out = cockpitTmuxOrThrow(['list-windows', '-t', `=${COCKPIT_SESSION}`, '-F', `#{window_id}${FIELD_SEPARATOR}#{${HOLDING_OPTION}}`]);
  const windows = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const [windowId, projectId] = line.split(FIELD_SEPARATOR);
    if (projectId && !windows.has(projectId)) windows.set(projectId, windowId);
  }
  return windows;
}

/** `projectId`'s holding window, created (with its keeper pane) when it has none. */
function ensureHoldingWindow(projectId: string, name: string): string {
  const existing = holdingWindows().get(projectId);
  if (existing) return existing;
  const [windowId, paneId] = cockpitTmuxOrThrow(['new-window', '-d', '-t', `=${COCKPIT_SESSION}:`, '-n', name || projectId,
    '-P', '-F', '#{window_id} #{pane_id}', '/bin/sh', '-c', keeperPaneScript()]).trim().split(' ');
  if (!windowId?.startsWith('@') || !paneId?.startsWith('%')) throw new Error(`unexpected tmux output '${windowId} ${paneId}'`);
  cockpitTmuxOrThrow(commandList([
    ['set-option', '-w', '-t', windowId, HOLDING_OPTION, projectId],
    ['set-option', '-p', '-t', paneId, ROLE_OPTION, 'keeper'],
  ]));
  return windowId;
}

/** A tab's pane, as it is created in its project's holding window. */
export interface TabPaneSpec {
  projectId: string;
  projectName: string;
  agentId: string | null;
  role: 'master' | 'message' | 'agent';
  /** A master pane's `masterKey`. */
  masterKey?: string;
  root: string;
  script: string;
}

/** The options naming a tab's pane. */
export function tabPaneOptions(paneId: string, spec: Pick<TabPaneSpec, 'role' | 'projectId' | 'agentId' | 'masterKey'>): string[][] {
  return [
    ['set-option', '-p', '-t', paneId, ROLE_OPTION, spec.role],
    ['set-option', '-p', '-t', paneId, TAB_PROJECT_OPTION, spec.projectId],
    ['set-option', '-p', '-t', paneId, TAB_AGENT_OPTION, spec.agentId ?? ''],
    ['set-option', '-p', '-t', paneId, MASTER_KEY_OPTION, spec.masterKey ?? ''],
  ];
}

/** Creates a tab's pane in its project's holding window (not shown); returns its pane id. */
function createTabPane(spec: TabPaneSpec): string {
  const holding = ensureHoldingWindow(spec.projectId, spec.projectName);
  const paneId = cockpitTmuxOrThrow(['split-window', '-d', '-t', holding, '-c', spec.root, '-P', '-F', '#{pane_id}', '/bin/sh', '-c', spec.script]).trim();
  if (!paneId.startsWith('%')) throw new Error(`unexpected tmux output '${paneId}'`);
  cockpitTmuxOrThrow(commandList(tabPaneOptions(paneId, spec)));
  fitHoldingWindows();
  return paneId;
}

/** Moves `paneId` into `projectId`'s holding window. */
function holdPane(paneId: string, projectId: string, name: string): void {
  const holding = ensureHoldingWindow(projectId, name);
  cockpitTmuxOrThrow(['join-pane', '-d', '-s', paneId, '-t', holding]);
}

/** Splits a placeholder into a frame whose slot was closed, and restores the frame's sizes. */
function ensureSlot(frame: CockpitFrame | null): void {
  if (!frame || frame.slot || !frame.tabbar || !frame.sidebar) return;
  const paneId = cockpitTmuxOrThrow(['split-window', '-v', '-d', '-t', frame.tabbar, '-P', '-F', '#{pane_id}', '/bin/sh', '-c', placeholderPaneScript()]).trim();
  cockpitTmuxOrThrow(commandList([['set-option', '-p', '-t', paneId, ROLE_OPTION, 'placeholder'], ...frameSizeCommands(frame.sidebar, frame.tabbar)]));
}

/** What builds a frame: the sidebar's command and where its panes start. */
interface FrameSpec { root: string; sidebarScript: string; tabBarScript: string }

/** Lays out a frame around its sidebar pane: the tab bar beside it, a placeholder slot below that, the sizes kept. */
function buildFrame(windowId: string, sidebar: string, spec: FrameSpec): void {
  const split = (direction: '-h' | '-v', target: string, script: string) => {
    const paneId = cockpitTmuxOrThrow(['split-window', direction, '-d', '-t', target, '-c', spec.root, '-P', '-F', '#{pane_id}', '/bin/sh', '-c', script]).trim();
    if (!paneId.startsWith('%')) throw new Error(`unexpected tmux output '${paneId}'`);
    return paneId;
  };
  const tabbar = split('-h', sidebar, spec.tabBarScript);
  const slot = split('-v', tabbar, placeholderPaneScript());
  cockpitTmuxOrThrow(commandList([
    ['set-option', '-w', '-t', windowId, FRAME_OPTION, '1'],
    ['set-option', '-p', '-t', sidebar, ROLE_OPTION, 'sidebar'],
    ['set-option', '-p', '-t', tabbar, ROLE_OPTION, 'tabbar'],
    ['set-option', '-p', '-t', slot, ROLE_OPTION, 'placeholder'],
    ...frameSizeCommands(sidebar, tabbar),
    frameResizeHook(windowId, sidebar, tabbar),
    ['select-window', '-t', windowId],
  ]));
}

/**
 * Makes the sidebar's dashboard run for `project` (the one `orc start-session`
 * ran in, listed first and marked current), respawning it when it ran for another.
 */
function showSidebarProject(project: Pick<CockpitProject, 'id' | 'root'>, sidebarScript: string): void {
  const sidebar = cockpitPanes().find((pane) => pane.inFrame && pane.role === 'sidebar');
  if (!sidebar || sidebar.projectId === project.id) return;
  cockpitTmuxOrThrow(commandList([
    ...(sidebar.projectId ? [['respawn-pane', '-k', '-t', sidebar.paneId, '-c', project.root, '/bin/sh', '-c', sidebarScript]] : []),
    ['set-option', '-p', '-t', sidebar.paneId, TAB_PROJECT_OPTION, project.id],
  ]));
}

/** The frame, built in a new window (its sidebar running `spec.sidebarScript`). */
function newFrameWindow(spec: FrameSpec): void {
  const created = cockpitTmuxOrThrow(['new-window', '-d', '-t', `=${COCKPIT_SESSION}:`, '-n', FRAME_NAME, '-c', spec.root,
    '-P', '-F', '#{window_id} #{pane_id}', '/bin/sh', '-c', spec.sidebarScript]);
  const { windowId, paneId } = parseCreated(created);
  buildFrame(windowId, paneId, spec);
}

function parseCreated(out: string): { windowId: string; paneId: string } {
  const [windowId, paneId] = out.trim().split(' ');
  if (!windowId?.startsWith('@') || !paneId?.startsWith('%')) throw new Error(`unexpected tmux output '${out.trim()}'`);
  return { windowId, paneId };
}

/**
 * Makes sure the session has a whole frame: a slot is added to one that lost
 * it; one that lost its sidebar or tab bar is rebuilt, its tab panes kept in
 * their holding windows; a session without one gets one.
 */
function ensureFrame(spec: FrameSpec): void {
  const panes = cockpitPanes();
  const frame = frameOf(panes);
  if (frame?.sidebar && frame.tabbar) {
    ensureSlot(frame);
    cockpitTmuxOrThrow(commandList([...frameSizeCommands(frame.sidebar, frame.tabbar), frameResizeHook(frame.windowId, frame.sidebar, frame.tabbar)]));
    return;
  }
  if (frame) {
    for (const pane of panes.filter((entry) => entry.windowId === frame.windowId && paneTab(entry))) holdPane(pane.paneId, pane.projectId, pane.projectId);
    cockpitTmux(['kill-window', '-t', frame.windowId]);
  }
  newFrameWindow(spec);
}

interface LegacyWindow { windowId: string; name: string; projectId: string; masterPane: string; master: string; agentId: string; agentProjectId: string }

/**
 * Rebuilds a cockpit from before the frame (a window per project, master pane
 * beside a dashboard, and a window per agent tab): each master pane and agent
 * tab pane moves, still running, into its project's holding window, and the
 * old windows (only their dashboards left) close. No master, worker or
 * coordinator is stopped, and no stream reconnects. Returns how many windows it rebuilt.
 */
function migrateLegacyWindows(): number {
  const out = cockpitTmuxOrThrow(['list-windows', '-t', `=${COCKPIT_SESSION}`, '-F', [
    '#{window_id}', '#{window_name}', `#{${LEGACY_MASTER_PANE_OPTION}}`, `#{${LEGACY_MASTER_OPTION}}`, `#{${LEGACY_AGENT_ID_OPTION}}`,
    `#{${LEGACY_AGENT_PROJECT_OPTION}}`, `#{${LEGACY_PROJECT_OPTION}}`,
  ].join(FIELD_SEPARATOR)]);
  const legacy: LegacyWindow[] = out.split('\n').filter(Boolean).map((line) => {
    const [windowId = '', name = '', masterPane = '', master = '', agentId = '', agentProjectId = '', projectId = ''] = line.split(FIELD_SEPARATOR);
    return { windowId, name, projectId, masterPane, master, agentId, agentProjectId };
  }).filter((window) => window.projectId || (window.agentId && window.agentProjectId));
  // Project windows first: an agent tab's holding window takes its project's name.
  const ordered = [...legacy.filter((window) => window.projectId), ...legacy.filter((window) => !window.projectId)];
  for (const window of ordered) {
    const panes = cockpitTmuxOrThrow(['list-panes', '-t', window.windowId, '-F', '#{pane_id}']).split('\n').filter(Boolean);
    const spec = window.projectId
      ? { pane: window.masterPane, projectId: window.projectId, name: window.name, role: 'master' as const, agentId: null, masterKey: window.master }
      : { pane: panes[0], projectId: window.agentProjectId, name: window.name.split('/')[0], role: 'agent' as const, agentId: window.agentId, masterKey: '' };
    if (spec.pane && panes.includes(spec.pane)) {
      holdPane(spec.pane, spec.projectId, spec.name);
      cockpitTmuxOrThrow(commandList(tabPaneOptions(spec.pane, spec)));
    }
    cockpitTmux(['kill-window', '-t', window.windowId]);
  }
  return legacy.length;
}

export type CockpitWindowOutcome = 'created-session' | 'added-project' | 'respawned-master' | 'existing';

/**
 * Creates the cockpit (or reuses it) and makes sure `project` has a master
 * tab attaching to `master`, then shows the project with the slot focused.
 * Idempotent: a project already in the cockpit keeps its tabs and comes back
 * with the tab it last showed; one whose master changed, or that showed a
 * message because it was stopped, has its master pane respawned (and shown).
 * A cockpit with the old layout (a window per project) is rebuilt first.
 */
export function ensureCockpitWindow(spec: {
  project: CockpitProject;
  master: CockpitMaster;
  watchCommand: string[];
  /** The command that runs orc (node and its entry point): the cockpit keys and the tab bar run `orc cockpit` with it. */
  orc: string[];
  options: CockpitOptions;
  keys: CockpitKeys;
  size?: { columns?: number; rows?: number };
}): CockpitWindowOutcome {
  const { project, master, options } = spec;
  const frame: FrameSpec = {
    root: project.root,
    sidebarScript: dashboardPaneScript(project, spec.watchCommand),
    tabBarScript: tabBarPaneScript(spec.orc),
  };

  const hasCockpit = () => cockpitTmux(['has-session', '-t', `=${COCKPIT_SESSION}`]).status === 0;
  // The lock sits beside the cockpit's socket, in tmux's per-user directory, which a first server has not made yet.
  mkdirSync(dirname(cockpitLockPath()), { recursive: true, mode: 0o700 });
  // All under the lock: the tab bar, or another start-session, must not see a frame half built or rebuilt.
  return withCockpitLock(() => {
    let created: { windowId: string; paneId: string } | null = null;
    if (!hasCockpit()) {
      const columns = spec.size?.columns || DEFAULT_SIZE.columns;
      const rows = spec.size?.rows || DEFAULT_SIZE.rows;
      const started = cockpitTmux(commandList([
        ...cockpitServerOptions({ trueColor: options.trueColor, terminal: cockpitTerminal(), keys: spec.keys, orc: spec.orc }),
        ['new-session', '-d', '-s', COCKPIT_SESSION, '-x', String(columns), '-y', String(rows), '-n', FRAME_NAME, '-c', project.root,
          '-P', '-F', '#{window_id} #{pane_id}', '/bin/sh', '-c', frame.sidebarScript],
      ]));
      if (!started.error && started.status === 0) {
        created = parseCreated(started.stdout);
      } else if (!hasCockpit()) {
        throw started.error ?? new Error(`tmux new-session failed: ${(started.stderr || '').trim() || `exit ${started.status}`}`);
      }
      // Otherwise another cockpit server came up first (outside orc's lock): add this project to it.
    }
    const createdSession = created !== null;
    if (created) {
      buildFrame(created.windowId, created.paneId, frame);
    } else {
      // A running cockpit, maybe created with other keys or the old layout: apply these keys, build its frame
      // (first, so closing the old windows never ends the session), then move the old windows' tabs into it.
      cockpitTmuxOrThrow(commandList([...cockpitKeyOptions(spec.keys, boundCockpitKeys(), spec.orc), ['move-window', '-r', '-t', `=${COCKPIT_SESSION}`]]));
      ensureFrame(frame);
      if (migrateLegacyWindows() > 0) fitHoldingWindows();
    }
    showSidebarProject(project, frame.sidebarScript);
    const key = masterKey(master);
    const masterCommand = masterPaneScript(master, project, options);
    const pane = cockpitPanes().find((entry) => entry.projectId === project.id && (entry.role === 'master' || entry.role === 'message'));
    let outcome: CockpitWindowOutcome;
    if (pane?.role === 'master' && pane.masterKey === key) {
      outcome = 'existing';
    } else if (pane) {
      cockpitTmuxOrThrow(commandList([
        ['respawn-pane', '-k', '-t', pane.paneId, '-c', project.root, '/bin/sh', '-c', masterCommand],
        ...tabPaneOptions(pane.paneId, { role: 'master', projectId: project.id, agentId: null, masterKey: key }),
      ]));
      outcome = 'respawned-master';
    } else {
      createTabPane({ projectId: project.id, projectName: project.name, agentId: null, role: 'master', masterKey: key, root: project.root, script: masterCommand });
      outcome = createdSession ? 'created-session' : 'added-project';
    }
    const result = applyTransitionLocked((state) => {
      const selected = selectProject(state, project.id);
      return selected.ok && outcome !== 'existing' ? selectTab(selected.state, MASTER_TAB) : selected;
    });
    if (!result.ok) throw new Error(result.message);
    return outcome;
  });
}

/** The command that attaches this terminal to the cockpit. */
export function cockpitAttachCommand(): { command: string; args: string[] } {
  return { command: tmuxBinary(), args: ['-L', COCKPIT_SOCKET, '-f', '/dev/null', 'attach-session', '-t', `=${COCKPIT_SESSION}`] };
}

/** Whether `TMUX` says this process already runs inside the cockpit (a shell in one of its panes). */
export function insideCockpit(env: NodeJS.ProcessEnv = process.env): boolean {
  const socket = env.TMUX?.split(',')[0];
  return !!socket && socket === tmuxSocketPath(COCKPIT_SOCKET);
}

// ── Agent tabs ───────────────────────────────────────────────────────────────
// A worker's or scout's live terminal is a tab of its own in its project:
// `orc terminal <agent_id> --write`, a control-API stream, so opening it never
// attaches a tmux client to the agent's server (no resize on attach; only the
// lease holder sizes the pane, as docs/terminal-streaming.md says).

export interface CockpitAgentTab {
  projectId: string;
  projectName: string;
  agentId: string;
  /** Where the tab's shell starts. */
  root: string;
  /** What the tab runs: `orc terminal <agent_id> --write` for the agent's project. */
  command: string[];
  /** What closes the tab: `orc cockpit close <agent_id>`. */
  close: string[];
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
    close: [...orc, 'cockpit', 'close', agentId],
    env: unregistered ? { ORC_STATE_DIR: project.state_dir } : {},
  };
}

/** The pane a stopped project shows in its master's place. */
export function cockpitStoppedProject(project: CockpitTabProject): CockpitStoppedProject {
  return { projectId: project.project_id, projectName: project.name, root: project.target_repo_root };
}

/**
 * An agent tab's script: run the stream; when it ends (the agent's session
 * ended, the stream fell behind, or its own Ctrl-] detached it), say so and
 * wait: Enter closes the tab (`orc cockpit close`, run by the cockpit server
 * so it outlives this pane), `r` reconnects. Closing the tab only ends the
 * stream; the agent's session keeps running.
 */
export function agentTabScript(tab: Pick<CockpitAgentTab, 'agentId' | 'projectName' | 'command' | 'close' | 'env'>, tmux: string): string {
  const ended = `The terminal of ${tab.agentId} (${tab.projectName}) is closed`;
  // run-shell expands formats: a `#` must reach its shell as itself.
  const close = tab.close.map((part) => shellQuote(part).replace(/#/g, '##')).join(' ');
  return [
    'cockpit_tmux=$TMUX',
    `unset TMUX ${PER_PROJECT_ENV.filter((key) => key.startsWith('ORC_')).join(' ')}`,
    ...Object.entries(tab.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    'while :; do',
    '  clear',
    `  ${tab.command.map(shellQuote).join(' ')}`,
    '  code=$?',
    `  printf '\\n%s (exit %s).\\n%s\\n' ${shellQuote(ended)} "$code" ${shellQuote('Closing this tab never stops the agent. Enter: close the tab · r Enter: reconnect')}`,
    '  read -r answer || exit 0',
    '  [ "$answer" = r ] && continue',
    // The cockpit swaps the next tab in and closes this pane; exit only if it did not.
    `  TMUX=$cockpit_tmux ${shellQuote(tmux)} run-shell -b ${shellQuote(close)} 2>/dev/null || exit 0`,
    '  sleep 5',
    '  exit 0',
    'done',
  ].join('\n');
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

/**
 * Runs `fn` holding the cockpit lock; waits up to 5 s for another holder. A
 * lock left by a holder that died is broken by `acquireLock` once it is stale
 * (it re-checks the holder before removing it, so two waiters never both break it).
 */
export function withCockpitLock<T>(fn: () => T, path = cockpitLockPath()): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      acquireLock(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error;
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

/** The cockpit's panes, its frame, the open tabs, and the stored state kept in step with them (rebuilt from them when missing or corrupt). */
function cockpitView(): { panes: CockpitPane[]; frame: CockpitFrame | null; open: OpenTab[]; state: CockpitTabState } {
  const panes = cockpitPanes();
  const frame = frameOf(panes);
  const open = panes.map(paneTab).filter((tab): tab is OpenTab => tab !== null);
  const stored = parseTabs(cockpitTmux(['show-options', '-gqv', TABS_OPTION]).stdout?.trim()) ?? EMPTY_COCKPIT_STATE;
  return { panes, frame, open, state: reconcileTabs(stored, open, frame?.slot ? paneTab(frame.slot) : null) };
}

/** Resolves the agent tab to open when the shown tab has no pane yet. */
export type AgentTabResolver = (projectId: string, agentId: string) => CockpitAgentTab;
/** Resolves a project to show that has no master tab: it is not running, so it shows a message. */
export type StoppedProjectResolver = (projectId: string) => CockpitStoppedProject;

export type CockpitActionResult = TabTransition & {
  /** A new agent tab pane was opened. */
  opened: boolean;
};

const NO_FRAME = 'the cockpit has no frame window; run orc start-session to rebuild it';

function applyTransitionLocked(
  transition: (state: CockpitTabState, open: OpenTab[]) => TabTransition,
  resolveAgentTab?: AgentTabResolver,
  resolveStoppedProject?: StoppedProjectResolver,
): CockpitActionResult {
  const before = cockpitView();
  ensureSlot(before.frame);
  const { panes, frame, open, state } = before.frame?.slot ? before : cockpitView();
  if (!frame?.slot) throw new Error(NO_FRAME);
  const store = (next: CockpitTabState) => cockpitTmuxOrThrow(['set-option', '-g', TABS_OPTION, serializeTabs(next)]);

  let result: TabTransition = transition(state, open);
  const shown = result.ok ? shownTab(result.state) : null;
  if (shown && shown.agentId === null && !findTabPane(panes, shown) && !resolveStoppedProject) {
    result = { ok: false, state, message: `${shown.projectId} has no master tab in the cockpit; run orc start-session in it.` };
  }
  if (!result.ok) {
    store(state);
    return { ...result, state, opened: false };
  }
  let opened = false;
  if (shown) {
    if (!findTabPane(panes, shown)) {
      if (shown.agentId === null) {
        const project = resolveStoppedProject!(shown.projectId);
        createTabPane({ ...project, agentId: null, role: 'message', script: messagePaneScript(project) });
      } else {
        const tab = (resolveAgentTab ?? ((projectId, agentId) => {
          throw new Error(`cannot open a tab for ${agentId} (${projectId}) here`);
        }))(shown.projectId, shown.agentId);
        createTabPane({ ...tab, role: 'agent', script: agentTabScript(tab, tmuxBinary()) });
        opened = true;
      }
    }
    const now = cockpitPanes();
    const target = findTabPane(now, shown)!;
    const slot = frameOf(now)!.slot!;
    const holding = holdingWindows();
    if (paneTab(slot) && !holding.has(slot.projectId)) holding.set(slot.projectId, ensureHoldingWindow(slot.projectId, slot.projectId));
    cockpitTmuxOrThrow(commandList(slotCommands({ ...frame, slot }, target, (projectId) => holding.get(projectId) ?? null)));
  }
  store(result.state);
  const closed = closedTabs(state, result.state);
  if (closed.length > 0) {
    const now = cockpitPanes();
    for (const tab of closed) {
      const pane = findTabPane(now, tab);
      if (pane) cockpitTmuxOrThrow(['kill-pane', '-t', pane.paneId]);
    }
  }
  // An explorer that left the slot is closed: it exists only while shown.
  for (const pane of cockpitPanes().filter((pane) => pane.role === 'explorer' && !pane.inFrame)) {
    cockpitTmuxOrThrow(['kill-pane', '-t', pane.paneId]);
  }
  fitHoldingWindows();
  return { ...result, opened };
}

/**
 * Applies one transition to the cockpit, serialized with every other: reads
 * the stored state (rebuilt from the open tab panes when missing or corrupt,
 * and kept in step with them), applies `transition`, swaps the active tab's
 * pane into the slot (opening it through `resolveAgentTab`, or a stopped
 * project's message through `resolveStoppedProject`, when it has none),
 * stores the state and closes the panes of closed tabs. A refused transition
 * changes no pane. Closing a tab only ends its pane's stream: no master,
 * worker or coordinator is stopped.
 */
export function applyCockpitTransition(
  transition: (state: CockpitTabState, open: OpenTab[]) => TabTransition,
  resolveAgentTab?: AgentTabResolver,
  resolveStoppedProject?: StoppedProjectResolver,
): CockpitActionResult {
  return withCockpitLock(() => applyTransitionLocked(transition, resolveAgentTab, resolveStoppedProject));
}

/** Shows the active tab again: puts a slot back into a frame that lost it. */
export function refreshCockpit(): CockpitActionResult {
  return applyCockpitTransition((state) => ({ ok: true, state, message: 'Refreshed the cockpit.' }));
}

/** The stored tab state, kept in step with the open tab panes; read-only. */
export function readCockpitTabs(): CockpitTabState {
  return cockpitView().state;
}

/** What the tab bar shows: the state, each project's name (its holding window's), and whether the slot is gone. */
export interface CockpitBarView { state: CockpitTabState; names: Record<string, string>; slotMissing: boolean }

export function readCockpitBar(): CockpitBarView {
  const { panes, frame, state } = cockpitView();
  const names: Record<string, string> = {};
  for (const pane of panes) if (pane.holding && !names[pane.holding]) names[pane.holding] = pane.windowName;
  return { state, names, slotMissing: !!frame && !frame.slot };
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
 * Shows `tab`'s agent tab in the slot, opening it first when the agent has
 * none (so one tab, and one stream, per agent).
 */
export function openAgentTab(tab: CockpitAgentTab): 'opened' | 'switched' {
  const result = applyCockpitTransition((state) => openAgent(state, tab.projectId, tab.agentId), () => tab);
  if (!result.ok) throw new Error(result.message);
  return result.opened ? 'opened' : 'switched';
}

/** The holding window the task explorer's pane waits in while it is not shown. */
const EXPLORER_HOLDING = 'explorer';

/**
 * Shows the task explorer for `projectId` in the slot, in place of the active
 * tab (which stays the active tab, and comes back on close). Opens the
 * explorer's pane when there is none; one that is already shown is left as it
 * is. Returns whether it was opened or was already shown.
 */
export function openExplorer(projectId: string, orc: string[]): 'opened' | 'switched' {
  return withCockpitLock(() => {
    ensureSlot(frameOf(cockpitPanes()));
    const panes = cockpitPanes();
    // An explorer pane left outside the frame (a plain tmux key moved it) is stale: only one may exist.
    for (const stale of panes.filter((pane) => pane.role === 'explorer' && !pane.inFrame)) {
      cockpitTmuxOrThrow(['kill-pane', '-t', stale.paneId]);
    }
    const frame = frameOf(panes);
    if (!frame?.slot) throw new Error(NO_FRAME);
    if (frame.slot.role === 'explorer') return 'switched';
    const holding = holdingWindows();
    const windowId = holding.get(EXPLORER_HOLDING) ?? ensureHoldingWindow(EXPLORER_HOLDING, 'tasks');
    const paneId = cockpitTmuxOrThrow(['split-window', '-d', '-t', windowId, '-P', '-F', '#{pane_id}', '/bin/sh', '-c', explorerPaneScript(orc, projectId, tmuxBinary())]).trim();
    if (!paneId.startsWith('%')) throw new Error(`unexpected tmux output '${paneId}'`);
    cockpitTmuxOrThrow(commandList([['set-option', '-p', '-t', paneId, ROLE_OPTION, 'explorer']]));
    const target = cockpitPanes().find((pane) => pane.paneId === paneId);
    if (!target) throw new Error(`the task explorer pane ${paneId} did not start`);
    const slot = frame.slot;
    if (paneTab(slot) && !holding.has(slot.projectId)) holding.set(slot.projectId, ensureHoldingWindow(slot.projectId, slot.projectId));
    cockpitTmuxOrThrow(commandList(slotCommands({ ...frame, slot }, target, (id) => holding.get(id) ?? null)));
    fitHoldingWindows();
    return 'opened';
  });
}

/** Shows `projectId`'s master tab; false when the project has no tab. */
export function switchToMasterTab(projectId: string): boolean {
  return applyCockpitTransition((state) => {
    const selected = selectProject(state, projectId);
    return selected.ok ? selectTab(selected.state, MASTER_TAB) : selected;
  }).ok;
}

/** Focuses the frame's slot (Esc in the sidebar); false when the cockpit has no slot. */
export function focusCockpitSlot(): boolean {
  const frame = frameOf(cockpitPanes());
  if (!frame?.slot) return false;
  cockpitTmuxOrThrow(commandList([['select-window', '-t', frame.windowId], ['select-pane', '-t', frame.slot.paneId]]));
  return true;
}
