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
import { execFile, spawn } from 'node:child_process';
import type { ProjectWatchState } from '../../client.ts';
import { NESTED_PROVIDER_ENV_KEYS } from '../providerChildEnv.ts';
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
export const isShellTab = (id: string | null | undefined): id is `shell:${string}` => typeof id === 'string' && id.startsWith(SHELL_TAB_PREFIX);
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
 * An agent session tab's id (`agent:N`): a provider CLI the cockpit started
 * on its private tmux server, outside the coordinator (never a registered
 * agent: no orc hooks, bootstrap or session secret). Never an agent id (they
 * have no `:`) nor a shell tab's.
 */
export const AGENT_TAB_PREFIX = 'agent:';
export const isAgentSessionTab = (id: string | null | undefined): id is `agent:${string}` => typeof id === 'string' && id.startsWith(AGENT_TAB_PREFIX);
/** The next free agent session tab id among `tabs`: `agent:1`, `agent:2`, ... */
export function nextAgentTab(tabs: readonly string[]): string {
  for (let n = 1; ; n += 1) if (!tabs.includes(`${AGENT_TAB_PREFIX}${n}`)) return `${AGENT_TAB_PREFIX}${n}`;
}
/** An agent session tab's tmux session on the private server. */
export function agentSessionName(projectId: string, tabId: string): string {
  return `agent-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}-${tabId.slice(AGENT_TAB_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
/** A tab the cockpit owns the session of (a shell or an agent session): closing the tab ends it, and it ending closes the tab. */
export const isOwnedSessionTab = (id: string | null | undefined): id is `shell:${string}` | `agent:${string}` => isShellTab(id) || isAgentSessionTab(id);

/** The variables an agent session never inherits: orc's (ORC_*) and a parent provider session's (lib/providerChildEnv.ts). */
const unsetScript = (extra: readonly string[]) =>
  `for v in $(env | sed -n "s/^\\(ORC_[A-Za-z0-9_]*\\)=.*/\\1/p"); do unset "$v"; done;${extra.length ? ` unset ${extra.join(' ')};` : ''}`;

/**
 * What an agent session runs: `command` (the provider CLI) without ORC_* or
 * a parent provider session's variables; when it fails, a line saying so,
 * kept until a key is pressed (the session ending closes the tab).
 */
export function agentScript(command: string): string {
  return `${unsetScript(NESTED_PROVIDER_ENV_KEYS)} ${command} || { printf '\\n[%s exited with status %s; any key closes this tab]\\n' ${shellWord(command)} "$?"; stty raw -echo 2>/dev/null; dd bs=1 count=1 >/dev/null 2>&1; }`;
}
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Lines on a provider's screen that ask the user first (trust this folder, accept Claude's bypass-permissions mode): a prompt sent then would answer them. */
const STARTUP_QUESTION = /do you trust|trust (?:this|the files in this) folder|yes, continue|press enter to continue|bypass permissions mode|yes, i accept/i;

/**
 * The keys that answer the startup question on a full-access session's
 * screen, or null when it asks none: Claude's bypass-permissions
 * confirmation takes `2` (Yes, I accept) then Enter; a trust or continue
 * question takes Enter (its default is to trust and go on).
 */
export function startupAnswer(text: string): string[] | null {
  if (/bypass permissions mode/i.test(text) && /yes, i accept/i.test(text)) return ['2', 'Enter'];
  if (STARTUP_QUESTION.test(text)) return ['Enter'];
  return null;
}

/**
 * Whether a pane's text shows a provider ready for its first message: drawn
 * and not asking a startup question. The caller also waits for it to settle.
 */
export function agentScreenReady(text: string): boolean {
  return text.trim() !== '' && !STARTUP_QUESTION.test(text);
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
  /**
   * Starts `command` (a provider CLI, agentScript) in `cwd` in session `session`
   * (an agent session tab, `agentSessionName`) without orc's variables; returns its target.
   */
  startAgent(session: string, cwd: string, size: { cols: number; rows: number }, command: string): Promise<TmuxTarget>;
  /**
   * Sends `text` as the first message of the agent session at `target`: once its
   * screen is ready (`agentScreenReady`) and has settled, as a bracketed paste,
   * then Enter, as a worker's bootstrap is sent; rejects when it never got ready.
   */
  sendPrompt(target: TmuxTarget, text: string): Promise<void>;
  /**
   * Answers a full-access session's startup questions the way orc's worker
   * launcher does (trust the folder: Enter; Claude's bypass-permissions
   * confirmation: "2. Yes, I accept"), until the session is ready; resolves
   * once it is (or after a timeout: whatever is left stays for the user).
   */
  acceptStartup(target: TmuxTarget): Promise<void>;
  /** Kills an explorer's session, resolving once tmux has; errors are ignored (it may be gone already). */
  stop(target: TmuxTarget): Promise<void>;
}

export interface TmuxExplorerHostOptions {
  tmuxBinary: string;
  /** The private server's socket name (default `orc-explorer`). */
  socket?: string;
  /** The shell command that runs the explorer for a project. */
  command: (projectId: string) => string;
  /** How often a prompt's session is looked at for readiness (default 250 ms). */
  promptPollMs?: number;
  /** How long a ready screen must stay unchanged before the prompt is sent (default 1500 ms). */
  promptSettleMs?: number;
  /** How long to wait for a ready screen before giving up (default 120 s: the user may be answering a startup question). */
  promptTimeoutMs?: number;
  /** The pause between the paste and its Enter (default 500 ms, as a worker's bootstrap). */
  promptEnterDelayMs?: number;
  /** How long a full-access session's startup questions are answered before they are left to the user (default 30 s). */
  startupTimeoutMs?: number;
  /** The pause after answering a startup question, for its dialog to go away (default 800 ms). */
  startupSettleMs?: number;
}

function runTmux(tmuxBinary: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return tmuxOutput(tmuxBinary, args, env).then(() => undefined);
}

function tmuxOutput(tmuxBinary: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tmuxBinary, args, { encoding: 'utf8', ...(env ? { env } : {}) }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** Runs tmux with `input` on its stdin (`load-buffer -`). */
function tmuxWithInput(tmuxBinary: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tmuxBinary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tmux exited with status ${code}`))));
    child.stdin.end(input);
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This process's environment for a session the cockpit starts: no orc variable, no parent provider session, not the cockpit's own tmux. */
function sessionEnv(): NodeJS.ProcessEnv {
  const drop = new Set<string>(['TMUX', 'TMUX_PANE', ...NESTED_PROVIDER_ENV_KEYS]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_') && !drop.has(key)));
}
/** The variables a session gets explicitly (`-e`), whatever the server's global environment holds. */
const sessionVars = (env: NodeJS.ProcessEnv): string[] => Object.entries(env)
  .filter(([key]) => key === 'SHELL' || key === 'HOME' || key === 'PATH' || key === 'LANG' || key === 'TERM')
  .flatMap(([key, value]) => ['-e', `${key}=${value}`]);

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
      const env = sessionEnv();
      await runTmux(options.tmuxBinary, ['-L', socket, '-f', '/dev/null', 'kill-session', '-t', `=${session}`], env).catch(() => { /* none left */ });
      await runTmux(options.tmuxBinary, [
        '-L', socket, '-f', '/dev/null',
        'new-session', '-d', '-s', session, '-x', String(Math.max(1, size.cols)), '-y', String(Math.max(1, size.rows)), '-c', cwd,
        ...sessionVars(env),
        // The server's global environment (from whichever start launched it) may hold ORC_*: unset them in the shell too.
        '/bin/sh', '-c', SHELL_SCRIPT,
        ';', 'set-option', 'status', 'off',
      ], env);
      return { socket, session };
    },
    async startAgent(session, cwd, size, command) {
      const env = sessionEnv();
      const base = ['-L', socket, '-f', '/dev/null'];
      await runTmux(options.tmuxBinary, [...base, 'kill-session', '-t', `=${session}`], env).catch(() => { /* none left */ });
      await runTmux(options.tmuxBinary, [
        ...base,
        'new-session', '-d', '-s', session, '-x', String(Math.max(1, size.cols)), '-y', String(Math.max(1, size.rows)), '-c', cwd,
        ...sessionVars(env),
        '/bin/sh', '-c', agentScript(command),
        ';', 'set-option', 'status', 'off',
      ], env);
      return { socket, session };
    },
    async sendPrompt(target, text) {
      const base = ['-L', target.socket, '-f', '/dev/null'];
      const pane = `=${target.session}:`;
      const pollMs = options.promptPollMs ?? 250;
      const settleMs = options.promptSettleMs ?? 1_500;
      const deadline = Date.now() + (options.promptTimeoutMs ?? 120_000);
      let last: string | null = null;
      let since = Date.now();
      for (;;) {
        const screen = await tmuxOutput(options.tmuxBinary, [...base, 'capture-pane', '-p', '-t', pane]);
        if (screen !== last) { last = screen; since = Date.now(); }
        else if (agentScreenReady(screen) && Date.now() - since >= settleMs) break;
        if (Date.now() >= deadline) throw new Error('the session never got ready for its prompt');
        await delay(pollMs);
      }
      const buffer = `prompt-${target.session}`;
      await tmuxWithInput(options.tmuxBinary, [...base, 'load-buffer', '-b', buffer, '-'], text);
      await runTmux(options.tmuxBinary, [...base, 'paste-buffer', '-d', '-p', '-b', buffer, '-t', pane]);
      await delay(options.promptEnterDelayMs ?? 500);
      await runTmux(options.tmuxBinary, [...base, 'send-keys', '-t', pane, 'Enter']);
    },
    async acceptStartup(target) {
      const base = ['-L', target.socket, '-f', '/dev/null'];
      const pane = `=${target.session}:`;
      const pollMs = options.promptPollMs ?? 250;
      const settleMs = options.promptSettleMs ?? 1_500;
      const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
      let last: string | null = null;
      let since = Date.now();
      while (Date.now() < deadline) {
        const screen = await tmuxOutput(options.tmuxBinary, [...base, 'capture-pane', '-p', '-t', pane]);
        if (screen !== last) { last = screen; since = Date.now(); }
        const answer = startupAnswer(screen);
        if (answer) {
          for (const key of answer) {
            await runTmux(options.tmuxBinary, [...base, 'send-keys', '-t', pane, key]);
            await delay(200);
          }
          // Let the dialog go away before looking again.
          await delay(options.startupSettleMs ?? 800);
          last = null;
          continue;
        }
        if (agentScreenReady(screen) && Date.now() - since >= settleMs) return;
        await delay(pollMs);
      }
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
