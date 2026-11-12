/**
 * lib/cockpit2/explorer.ts — the task explorer tab and the attention queue (Plan 6 Step 11).
 *
 * The task explorer (`orc cockpit explorer --project=<id>`, lib/tui/ExplorerView.ts)
 * runs in a session of the cockpit's private tmux server (`orc-explorer`), so
 * the cockpit shows it through the same control client, screen and slot as
 * an agent's tab. It exists only while it is shown: opening it starts the
 * session, closing it kills the session and the active tab is shown again,
 * and an explorer that quits (Esc or q in its list) ends its session, which
 * closes the tab.
 *
 * The attention queue lists the agents needing a human across the projects
 * the watcher reports, for `nextAttention` (lib/cockpitTabs.ts): the
 * cockpit's projects first, in their order, then the other registered ones;
 * within a project permission prompts first. A project whose coordinator is
 * not running is left out (its status may be stale).
 */
import { execFile } from 'node:child_process';
import type { ProjectWatchState } from '../../client.ts';
import type { AttentionAgent, CockpitTabState } from '../cockpitTabs.ts';
import type { TmuxTarget } from './viewState.ts';

/** The cockpit's private tmux server: it hosts only views the cockpit started (the task explorer). */
export const EXPLORER_SOCKET = 'orc-explorer';

/** The explorer's tmux session for `projectId`; tmux reserves `:` and `.` in target names. */
export function explorerSessionName(projectId: string): string {
  return `explorer-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** A shell tab's id in a project's tabs (never an agent id: agent ids have no `:`), and its number back. */
export const SHELL_TAB_PREFIX = 'shell:';
export const isShellTab = (id: string | null | undefined): id is string => typeof id === 'string' && id.startsWith(SHELL_TAB_PREFIX);
/** The next free shell tab id among `tabs`: `shell:1`, `shell:2`, ... */
export function nextShellTab(tabs: readonly string[]): string {
  for (let n = 1; ; n += 1) if (!tabs.includes(`${SHELL_TAB_PREFIX}${n}`)) return `${SHELL_TAB_PREFIX}${n}`;
}
/** What a shell tab's session runs: the user's login shell, with no ORC_* variable left in its environment. */
export const SHELL_SCRIPT = 'for v in $(env | sed -n "s/^\\(ORC_[A-Za-z0-9_]*\\)=.*/\\1/p"); do unset "$v"; done; exec "${SHELL:-/bin/sh}" -l';
/** A shell tab's tmux session on the private server. */
export function shellSessionName(projectId: string, tabId: string): string {
  return `shell-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}-${tabId.slice(SHELL_TAB_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * The shell script the explorer's session runs: `command`, and when it fails
 * a line saying so, kept on screen until a key is pressed (a session that
 * ends on its own is closed by the cockpit, which would hide the error); the
 * key ends the session, so the cockpit closes the tab.
 */
export function explorerScript(command: string): string {
  return `${command} || { printf '\\n[the task explorer exited with status %s; any key closes this tab]\\n' "$?"; stty raw -echo 2>/dev/null; dd bs=1 count=1 >/dev/null 2>&1; }`;
}

/** Starts and stops explorer sessions; the CLI layer passes one in, tests a fake. */
export interface ExplorerHost {
  /** Starts the explorer of `projectId` in a session `cols` by `rows` (replacing a leftover one) and returns its target. */
  start(projectId: string, size: { cols: number; rows: number }): Promise<TmuxTarget>;
  /** Starts the user's login shell in `cwd` in session `session` (a shell tab, `shellSessionName`); returns its target. */
  startShell(session: string, cwd: string, size: { cols: number; rows: number }): Promise<TmuxTarget>;
  /** Kills an explorer's session, resolving once tmux has; errors are ignored (it may be gone already). */
  stop(target: TmuxTarget): Promise<void>;
}

export interface TmuxExplorerHostOptions {
  tmuxBinary: string;
  /** The private server's socket name (default `orc-explorer`). */
  socket?: string;
  /** The shell command that runs the explorer for a project. */
  command: (projectId: string) => string;
}

function runTmux(tmuxBinary: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(tmuxBinary, args, { encoding: 'utf8', ...(env ? { env } : {}) }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}

/**
 * Explorer sessions on a private tmux server. The server reads no tmux
 * configuration (`-f /dev/null`), so the user's settings never change it,
 * and its sessions have no status line, so the pane fills the window the
 * cockpit sizes to the slot.
 */
export function tmuxExplorerHost(options: TmuxExplorerHostOptions): ExplorerHost {
  const socket = options.socket ?? EXPLORER_SOCKET;
  const tmux = (args: string[]) => runTmux(options.tmuxBinary, ['-L', socket, '-f', '/dev/null', ...args]);
  return {
    async start(projectId, size) {
      const session = explorerSessionName(projectId);
      // A session left by a cockpit that crashed would make new-session fail.
      await tmux(['kill-session', '-t', `=${session}`]).catch(() => { /* none left */ });
      try {
        await tmux([
          'new-session', '-d', '-s', session, '-x', String(Math.max(1, size.cols)), '-y', String(Math.max(1, size.rows)),
          // Run by /bin/sh, not the server's default shell (the user's $SHELL, which may not be POSIX).
          '/bin/sh', '-c', explorerScript(options.command(projectId)),
          // The session new-session made is the current one for the commands after it.
          ';', 'set-option', 'status', 'off',
        ]);
      } catch (error) {
        // new-session may have made the session before a command after it failed: no session outlives a failed start.
        await tmux(['kill-session', '-t', `=${session}`]).catch(() => { /* none made */ });
        throw error;
      }
      return { socket, session };
    },
    async startShell(session, cwd, size) {
      // A shell started from the cockpit never sees orc's secrets or the cockpit's own tmux.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_') && key !== 'TMUX' && key !== 'TMUX_PANE'));
      await runTmux(options.tmuxBinary, ['-L', socket, '-f', '/dev/null', 'kill-session', '-t', `=${session}`], env).catch(() => { /* none left */ });
      await runTmux(options.tmuxBinary, [
        '-L', socket, '-f', '/dev/null',
        'new-session', '-d', '-s', session, '-x', String(Math.max(1, size.cols)), '-y', String(Math.max(1, size.rows)), '-c', cwd,
        ...Object.entries(env).filter(([key]) => key === 'SHELL' || key === 'HOME' || key === 'PATH' || key === 'LANG' || key === 'TERM').flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        // The server's global environment (from whichever start launched it) may hold ORC_*: unset them in the shell too.
        '/bin/sh', '-c', SHELL_SCRIPT,
        ';', 'set-option', 'status', 'off',
      ], env);
      return { socket, session };
    },
    stop(target) {
      return runTmux(options.tmuxBinary, ['-L', target.socket, 'kill-session', '-t', `=${target.session}`]).catch(() => { /* gone already */ });
    },
  };
}

// ── attention ─────────────────────────────────────────────────────────────────

const ATTENTION_ORDER = ['permission_prompt', 'question', 'stalled', 'no_progress'];

/**
 * The agents needing attention across projects, in the order `nextAttention`
 * cycles through them: the cockpit's projects in order, then the other
 * watched ones; within a project by kind, permission prompts first. Projects
 * whose coordinator is not running are skipped.
 */
export function attentionQueue(state: CockpitTabState, projects: ProjectWatchState[]): AttentionAgent[] {
  const ids = [...state.projects.map((project) => project.projectId), ...projects.map((project) => project.project.id)];
  const order = ids.filter((id, index) => ids.indexOf(id) === index);
  return order.flatMap((projectId) => {
    const watched = projects.find((project) => project.project.id === projectId);
    if (watched?.connection !== 'running') return [];
    return (watched.status?.worker_capacity.slots ?? [])
      .filter((slot) => slot.attention)
      .sort((a, b) => ATTENTION_ORDER.indexOf(a.attention!.kind) - ATTENTION_ORDER.indexOf(b.attention!.kind))
      .map((slot): AttentionAgent => ({ projectId, agentId: slot.agent_id, ...(slot.role === 'master' ? { master: true } : {}) }));
  });
}
