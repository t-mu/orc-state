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
 * The server starts with no config file (`-f /dev/null`), and its prefix is
 * COCKPIT_PREFIX, the one key it claims: every other key, Ctrl-b included,
 * reaches the focused pane. Mouse stays off, so the terminal handles the
 * mouse as it does for a direct attach.
 */
import { spawnSync } from 'node:child_process';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { shellQuote, tmuxBinary, tmuxSocketPath } from './tmux.ts';

/** The per-user cockpit server: tmux keeps it in the per-user 0700 socket directory. */
export const COCKPIT_SOCKET = 'orc-cockpit';
export const COCKPIT_SESSION = 'cockpit';
/** The one key the cockpit claims: its tmux prefix. Pressed twice, it reaches the pane. */
export const COCKPIT_PREFIX = 'C-]';
/** How to get around, shown on attach and in the status line. */
export const COCKPIT_KEYS = 'Ctrl-] o: switch pane | Ctrl-] n/p: next/previous project | Ctrl-] d: detach';
/** The dashboard pane's share of the window width. */
const DASHBOARD_WIDTH = '35%';
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

/** The dashboard pane's script: `orc watch` for the project, restarted if it exits. */
export function dashboardPaneScript(project: Pick<CockpitProject, 'env'>, watchCommand: string[]): string {
  return [
    'unset TMUX',
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
export function cockpitServerOptions(options: { trueColor: boolean; terminal: string }): string[][] {
  return [
    ['set-option', '-g', 'prefix', COCKPIT_PREFIX],
    ['set-option', '-g', 'prefix2', 'None'],
    ['unbind-key', 'C-b'],
    ['bind-key', COCKPIT_PREFIX, 'send-prefix'],
    // Esc reaches the provider CLI without tmux's default half-second wait.
    ['set-option', '-g', 'escape-time', '10'],
    ['set-option', '-g', 'default-terminal', options.terminal],
    ...(options.trueColor ? [['set-option', '-as', 'terminal-features', ',*:RGB']] : []),
    ['set-option', '-g', 'status-left', '[orc] '],
    ['set-option', '-g', 'status-right', COCKPIT_KEYS],
    ['set-option', '-g', 'status-right-length', String(COCKPIT_KEYS.length + 2)],
  ];
}

/** The pane layout of a window just created with its master pane `paneId`: the dashboard beside it, the window labelled, the master focused. */
export function windowLayoutCommands(windowId: string, paneId: string, project: CockpitProject, master: CockpitMaster, dashboardScript: string): string[][] {
  return [
    ['split-window', '-h', '-d', '-l', DASHBOARD_WIDTH, '-t', paneId, '-c', project.root, '/bin/sh', '-c', dashboardScript],
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

interface CockpitWindow { windowId: string; projectId: string; master: string; masterPane: string }

function cockpitWindows(): CockpitWindow[] {
  const out = cockpitTmuxOrThrow(['list-windows', '-t', `=${COCKPIT_SESSION}`, '-F',
    `#{window_id} #{${PROJECT_OPTION}} #{${MASTER_OPTION}} #{${MASTER_PANE_OPTION}}`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [windowId = '', projectId = '', master = '', masterPane = ''] = line.split(' ');
    return { windowId, projectId, master, masterPane };
  });
}

function windowPanes(windowId: string): string[] {
  return cockpitTmuxOrThrow(['list-panes', '-t', windowId, '-F', '#{pane_id}']).split('\n').filter(Boolean);
}

function parseCreated(out: string): { windowId: string; paneId: string } {
  const [windowId, paneId] = out.trim().split(' ');
  if (!windowId?.startsWith('@') || !paneId?.startsWith('%')) throw new Error(`unexpected tmux output '${out.trim()}'`);
  return { windowId, paneId };
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
  options: CockpitOptions;
  size?: { columns?: number; rows?: number };
}): CockpitWindowOutcome {
  const { project, master, options } = spec;
  const masterCommand = ['/bin/sh', '-c', masterPaneScript(master, project, options)];
  const dashboardScript = dashboardPaneScript(project, spec.watchCommand);
  const newPane = ['-n', project.name, '-c', project.root, '-P', '-F', '#{window_id} #{pane_id}', ...masterCommand];

  const hasCockpit = () => cockpitTmux(['has-session', '-t', `=${COCKPIT_SESSION}`]).status === 0;
  if (!hasCockpit()) {
    const columns = spec.size?.columns || DEFAULT_SIZE.columns;
    const rows = spec.size?.rows || DEFAULT_SIZE.rows;
    const created = cockpitTmux(commandList([
      ...cockpitServerOptions({ trueColor: options.trueColor, terminal: cockpitTerminal() }),
      ['new-session', '-d', '-s', COCKPIT_SESSION, '-x', String(columns), '-y', String(rows), ...newPane],
    ]));
    if (!created.error && created.status === 0) {
      const { windowId, paneId } = parseCreated(created.stdout);
      cockpitTmuxOrThrow(commandList(windowLayoutCommands(windowId, paneId, project, master, dashboardScript)));
      return 'created-session';
    }
    // Another start-session created the cockpit first: add this project's tab to it.
    if (!hasCockpit()) throw created.error ?? new Error(`tmux new-session failed: ${(created.stderr || '').trim() || `exit ${created.status}`}`);
  }

  const existing = cockpitWindows().find((window) => window.projectId === project.id);
  if (existing) {
    const panes = windowPanes(existing.windowId);
    if (panes.includes(existing.masterPane)) {
      if (panes.length < 2) {
        // The dashboard pane was closed: rebuild the layout around the master pane.
        cockpitTmuxOrThrow(commandList(windowLayoutCommands(existing.windowId, existing.masterPane, project, master, dashboardScript)));
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
  const { windowId, paneId } = parseCreated(cockpitTmuxOrThrow(['new-window', '-d', '-t', `=${COCKPIT_SESSION}:`, ...newPane]));
  cockpitTmuxOrThrow(commandList(windowLayoutCommands(windowId, paneId, project, master, dashboardScript)));
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
