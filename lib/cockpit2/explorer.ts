/**
 * lib/cockpit2/explorer.ts — the task explorer tab and the attention queue (Plan 6 Step 11).
 *
 * The task explorer (`orc cockpit2 explorer --project=<id>`, lib/tui/ExplorerView.ts)
 * runs in a session of the cockpit's private tmux server (`orc-cockpit2`), so
 * the cockpit shows it through the same control client, screen and slot as
 * an agent's tab. It exists only while it is shown: opening it starts the
 * session, closing it kills the session and the active tab is shown again.
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
export const EXPLORER_SOCKET = 'orc-cockpit2';

/** The explorer's tmux session for `projectId`; tmux reserves `:` and `.` in target names. */
export function explorerSessionName(projectId: string): string {
  return `explorer-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * The shell script the explorer's session runs: `command`, and when it fails
 * a line saying so, kept on screen until the cockpit closes the tab (a
 * session that ends on its own is closed by the cockpit, which would hide the error).
 */
export function explorerScript(command: string): string {
  return `${command} || { printf '\\n[the task explorer exited with status %s; q or Esc closes this tab]\\n' "$?"; while :; do sleep 3600; done; }`;
}

/** Starts and stops explorer sessions; the CLI layer passes one in, tests a fake. */
export interface ExplorerHost {
  /** Starts the explorer of `projectId` in a session `cols` by `rows` (replacing a leftover one) and returns its target. */
  start(projectId: string, size: { cols: number; rows: number }): Promise<TmuxTarget>;
  /** Kills an explorer's session; errors are ignored (it may be gone already). */
  stop(target: TmuxTarget): void;
}

export interface TmuxExplorerHostOptions {
  tmuxBinary: string;
  /** The private server's socket name (default `orc-cockpit2`). */
  socket?: string;
  /** The shell command that runs the explorer for a project. */
  command: (projectId: string) => string;
}

function runTmux(tmuxBinary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(tmuxBinary, args, { encoding: 'utf8' }, (error, _stdout, stderr) => {
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
      await tmux([
        'new-session', '-d', '-s', session, '-x', String(Math.max(1, size.cols)), '-y', String(Math.max(1, size.rows)),
        explorerScript(options.command(projectId)),
        // The session new-session made is the current one for the commands after it.
        ';', 'set-option', 'status', 'off',
      ]);
      return { socket, session };
    },
    stop(target) {
      runTmux(options.tmuxBinary, ['-L', target.socket, 'kill-session', '-t', `=${target.session}`]).catch(() => { /* gone already */ });
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
