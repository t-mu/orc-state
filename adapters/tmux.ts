/**
 * adapters/tmux.ts
 *
 * Runs provider CLIs inside tmux sessions on a private, per-state-dir tmux
 * socket. The tmux server, not the coordinator, owns the provider process, so
 * a session survives a coordinator restart and any later coordinator can
 * write to it (Task 202).
 *
 * Session handle format: tmux:{agentId}
 *
 * State written to STATE_DIR:
 *   pty-logs/{agentId}.log  — raw pane output via pipe-pane (truncated on each start())
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_DIR, hookEventPath } from '../lib/paths.ts';
import { taskLabelsPath } from '../hooks/orc-hook.ts';
import { stripAnsi } from '../lib/ansi.ts';
import { readProcessStart } from '../lib/processIdentity.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { withEventDbTransaction } from '../lib/eventLog.ts';
import { logger } from '../lib/logger.ts';
import { detectBlockingPromptFromText, prepareProviderLaunch, runStartupDialogs } from './providerLaunch.ts';
import type { SessionExitStatus, SessionInspection } from './interface.ts';

const OUTPUT_TAIL_BYTES = 8 * 1024;
const CAPTURE_LINES = 200;
/**
 * Scrollback kept per pane. A caller asking for a long tail (a scout's report)
 * reads it from the pane history, so the default 2000 lines are not enough.
 */
const HISTORY_LIMIT = 10_000;
/** Lines of pane history read per requested byte budget; TUI lines average well over 16 bytes. */
const BYTES_PER_CAPTURE_LINE = 16;
const SUBMIT_DELAY_MS = 200;

function tmuxBinary(): string { return process.env.ORC_TMUX_BIN ?? 'tmux'; }

/** One private tmux server per state dir; tmux keeps its sockets in a per-user 0700 directory. */
export function tmuxSocketName(stateDir = STATE_DIR): string {
  return `orc-${createHash('sha256').update(stateDir).digest('hex').slice(0, 12)}`;
}

/**
 * Where tmux keeps the socket for `-L name`: `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/name`.
 * tmux 3.3a leaves this file behind when its server exits, so orc removes it itself.
 */
export function tmuxSocketPath(name = tmuxSocketName()): string {
  const uid = process.getuid?.() ?? 0;
  return join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, name);
}

/** Ends the wait for a server that is still shutting down. */
const SERVER_EXIT_WAIT_MS = 2_000;
const SERVER_EXIT_POLL_MS = 50;

/**
 * Removes the socket file of orc's private tmux server when no server answers
 * on it. A live server's socket is never touched. A server that was just told
 * to exit (`kill-server`, or `kill-session` of its last session) can still
 * answer for a moment, so with `waitMs` the probe repeats until tmux says no
 * server is running, a server answers with live sessions, or the wait ends.
 * Returns whether a file was removed.
 */
export function removeDeadTmuxSocket(name = tmuxSocketName(), { waitMs = 0 }: { waitMs?: number } = {}): boolean {
  const path = tmuxSocketPath(name);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      if (!lstatSync(path).isSocket()) return false;
    } catch {
      return false;
    }
    const probe = spawnSync(tmuxBinary(), ['-L', name, 'list-sessions'], { encoding: 'utf8', timeout: 5_000 });
    // Only tmux's own "no server running" answer proves the socket is dead; a
    // timeout or any other failure may mean a live server we must not orphan.
    if (!probe.error && probe.status !== 0 && /no server running/.test(probe.stderr ?? '')) {
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    }
    // A server with sessions stays; anything else may be a server on its way out.
    if (probe.status === 0 && (probe.stdout ?? '').trim() !== '') return false;
    if (Date.now() >= deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SERVER_EXIT_POLL_MS);
  }
}

/** Kills orc's private tmux server for `stateDir` and removes its socket file. */
export function killTmuxServer(stateDir = STATE_DIR): void {
  const name = tmuxSocketName(stateDir);
  spawnSync(tmuxBinary(), ['-L', name, 'kill-server'], { encoding: 'utf8', timeout: 10_000 });
  removeDeadTmuxSocket(name, { waitMs: SERVER_EXIT_WAIT_MS });
}

/** Readable and injective: the hash keeps `a.b` and `a_b` from sharing a session. */
export function tmuxSessionName(agentId: string): string {
  const readable = agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `orc-${readable}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`;
}

/**
 * The command that opens a real tmux client on the worker's session in orc's
 * private server. Read-only (`-r`) unless `write`: the operator can scroll and
 * detach but keystrokes do not reach the worker. The socket and session names
 * recorded in the session's provider_ref win over the computed ones.
 */
export function tmuxAttachCommand(agentId: string, options: { write?: boolean; providerRef?: unknown } = {}): { command: string; args: string[] } {
  const ref = (options.providerRef ?? {}) as { tmux_socket?: unknown; tmux_session?: unknown };
  const socket = typeof ref.tmux_socket === 'string' && ref.tmux_socket ? ref.tmux_socket : tmuxSocketName();
  const session = typeof ref.tmux_session === 'string' && ref.tmux_session ? ref.tmux_session : tmuxSessionName(agentId);
  // `=name` matches the session name exactly rather than by prefix.
  return { command: tmuxBinary(), args: ['-L', socket, 'attach-session', ...(options.write ? [] : ['-r']), '-t', `=${session}`] };
}

function logPath(agentId: string) { return join(STATE_DIR, 'pty-logs', `${agentId}.log`); }
function settingsPath(agentId: string) { return join(STATE_DIR, 'pty-settings', `${agentId}.json`); }
/**
 * The launcher carries the session's environment, including its secret (task 231),
 * so it lives in a private temporary directory, never the state directory, and
 * removes itself and that directory before exec.
 */
function newLauncherPath(agentId: string) { return join(mkdtempSync(join(tmpdir(), 'orc-launch-')), `${agentId}.launch.sh`); }

function tmux(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  return spawnSync(tmuxBinary(), ['-L', tmuxSocketName(), ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}

function tmuxOrThrow(args: string[], options: { input?: string; env?: Record<string, string> } = {}): string {
  const result = tmux(args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tmux ${args[0]} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  return result.stdout;
}

/** Oldest tmux orc supports. */
export const MIN_TMUX_VERSION = '3.2';

/**
 * Parses `tmux -V` output to `[major, minor]`: `tmux 3.2` → [3, 2], `tmux 3.3a`
 * → [3, 3], `tmux next-3.5` → [3, 5]. A build from git master (`tmux master`)
 * reports no number and parses as Infinity. Anything else is null.
 */
export function parseTmuxVersion(output: string): [number, number] | null {
  const text = output.trim();
  if (/^tmux master$/.test(text)) return [Infinity, Infinity];
  const match = /^tmux (?:next-)?(\d+)\.(\d+)[a-z]?$/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export interface TmuxCheck {
  ok: boolean;
  /** The `tmux -V` output, or null when tmux could not be run. */
  version: string | null;
  /** Why tmux cannot be used; null when ok. */
  problem: string | null;
}

/** Whether `-V` output names a tmux at least MIN_TMUX_VERSION. */
export function checkTmuxVersion(output: string | null): TmuxCheck {
  if (output == null) return { ok: false, version: null, problem: `tmux is not installed (orc needs tmux >= ${MIN_TMUX_VERSION} on PATH, or ORC_TMUX_BIN)` };
  const version = output.trim();
  const parsed = parseTmuxVersion(version);
  if (!parsed) return { ok: false, version, problem: `cannot read the tmux version from '${version}' (orc needs tmux >= ${MIN_TMUX_VERSION})` };
  const [major, minor] = MIN_TMUX_VERSION.split('.').map(Number);
  const tooOld = parsed[0] < major || (parsed[0] === major && parsed[1] < minor);
  return tooOld
    ? { ok: false, version, problem: `${version} is too old; orc needs tmux >= ${MIN_TMUX_VERSION}` }
    : { ok: true, version, problem: null };
}

/** Runs `tmux -V` and checks it: orc runs every provider terminal session in tmux. */
export function checkTmux(): TmuxCheck {
  const result = spawnSync(tmuxBinary(), ['-V'], { encoding: 'utf8', timeout: 5_000 });
  return checkTmuxVersion(!result.error && result.status === 0 ? result.stdout : null);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `=name:` matches the session name exactly (not by prefix) and resolves to its
 * active pane; without the colon, pane commands read `=name` as a window name.
 */
function target(agentId: string): string { return `=${tmuxSessionName(agentId)}:`; }

function parseHandle(sessionHandle: unknown): string {
  const s = String(sessionHandle);
  if (!s.startsWith('tmux:') || s.length <= 5) throw new Error(`Invalid tmux session handle: ${String(sessionHandle)}`);
  return s.slice(5);
}

function inspect(agentId: string): SessionInspection {
  const result = tmux(['display-message', '-p', '-t', target(agentId), '#{pane_pid} #{pane_dead}']);
  if (result.error || result.status !== 0) {
    return { transport: 'tmux', alive: false, writable: false, pid: null, processStart: null, reason: 'tmux session not found' };
  }
  const [pidText, dead] = result.stdout.trim().split(' ');
  const pid = Number(pidText);
  const processStart = Number.isSafeInteger(pid) && pid > 0 ? readProcessStart(pid) : null;
  const alive = dead === '0' && processStart != null;
  return {
    transport: 'tmux', alive, writable: alive, pid: Number.isSafeInteger(pid) ? pid : null, processStart,
    ...(alive ? {} : { reason: 'tmux pane process exited' }),
  };
}

/**
 * tmux marks a pane dead on its pty's EOF, slightly before it reaps the process and records the status.
 * tmux before 3.3 has no `#{pane_dead_signal}`: a signal kill reads as no status after this wait (unknown).
 */
const EXIT_STATUS_WAIT_MS = 2_000;
const EXIT_STATUS_POLL_MS = 50;

/** A dead pane kept by `remain-on-exit`: its exit code or killing signal. */
function exitStatus(agentId: string): SessionExitStatus | null {
  const deadline = Date.now() + EXIT_STATUS_WAIT_MS;
  for (;;) {
    const result = tmux(['display-message', '-p', '-t', target(agentId), '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}']);
    if (result.error || result.status !== 0) return null;
    const [dead, status, signal] = result.stdout.trim().split('|');
    if (dead !== '1') return null;
    if (status || signal || Date.now() >= deadline) {
      const code = status ? Number(status) : Number.NaN;
      const sig = signal ? Number(signal) : Number.NaN;
      return { code: Number.isInteger(code) ? code : null, signal: Number.isInteger(sig) ? sig : (signal || null) };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EXIT_STATUS_POLL_MS);
  }
}

function capture(agentId: string, lines = CAPTURE_LINES): string | null {
  const result = tmux(['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', target(agentId)]);
  return result.status === 0 ? result.stdout : null;
}

function readLogTail(agentId: string, maxBytes = OUTPUT_TAIL_BYTES): string {
  const path = logPath(agentId);
  if (!existsSync(path)) return '';
  return readFileSync(path).subarray(-maxBytes).toString('utf8');
}

/** Bracketed paste keeps multi-line text intact; a separate Enter submits it. */
function write(agentId: string, text: string): void {
  if (text === '\r') {
    tmuxOrThrow(['send-keys', '-t', target(agentId), 'Enter']);
    return;
  }
  const buffer = tmuxSessionName(agentId);
  tmuxOrThrow(['load-buffer', '-b', buffer, '-'], { input: text });
  tmuxOrThrow(['paste-buffer', '-d', '-p', '-b', buffer, '-t', target(agentId)]);
}

/**
 * A coordinator send always goes through, even while an operator holds the
 * terminal's input lease: it records a short-lived `terminal_send` marker
 * (`COORDINATOR_SEND_RESOURCE` in lib/terminalBroker.ts) that makes operator
 * input fail with a retryable `busy` until the send is done.
 */
function markCoordinatorSend(agentId: string): { resourceId: string; leaseId: string } | null {
  if (!existsSync(join(STATE_DIR, 'events.db'))) return null;
  return withEventDbTransaction(STATE_DIR, (db) => {
    const session = db.prepare(`SELECT session_id, run_id FROM sessions WHERE agent_id = ? AND state = 'running'
      AND transport = 'tmux' ORDER BY rowid DESC LIMIT 1`).get(agentId) as { session_id: string; run_id: string | null } | undefined;
    if (!session?.run_id) return null;
    // Matches the broker's provider terminal id (`provider:<session_id>`).
    const resourceId = `provider:${session.session_id}`;
    const leaseId = randomUUID();
    db.prepare(`INSERT INTO control_leases (resource_type, resource_id, lease_id, owner_id, expires_at)
      VALUES ('terminal_send', ?, ?, ?, ?) ON CONFLICT (resource_type, resource_id) DO UPDATE SET
        lease_id = excluded.lease_id, owner_id = excluded.owner_id, expires_at = excluded.expires_at`)
      .run(resourceId, leaseId, `coordinator:${process.pid}`, new Date(Date.now() + 30_000).toISOString());
    return { resourceId, leaseId };
  });
}

function clearCoordinatorSend(marker: { resourceId: string; leaseId: string } | null): void {
  if (!marker) return;
  try {
    withEventDbTransaction(STATE_DIR, (db) => db.prepare(`DELETE FROM control_leases
      WHERE resource_type = 'terminal_send' AND resource_id = ? AND lease_id = ?`).run(marker.resourceId, marker.leaseId));
  } catch (error) {
    logger.warn(`[tmux] coordinator send marker cleanup failed: ${(error as Error).message}`);
  }
}

export interface TmuxLaunch { binary: string; args: string[]; env: Record<string, string>; cwd: string }

/**
 * Replaces any session named for `agentId` with a fresh detached one running
 * `launch`, its output piped to the agent's log. Returns the launcher's
 * private directory, which the caller removes once the pane has run it.
 */
function openSession(agentId: string, launch: TmuxLaunch, { remainOnExit = false }: { remainOnExit?: boolean } = {}): string {
  tmux(['kill-session', '-t', target(agentId)]);
  mkdirSync(dirname(logPath(agentId)), { recursive: true });
  writeFileSync(logPath(agentId), '');
  // A long-lived tmux server keeps the environment of whoever started it,
  // so each session gets its exact env from a private launcher script that
  // deletes itself before exec. Env values never appear in argv.
  const launcher = newLauncherPath(agentId);
  const exports = Object.entries(launch.env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  writeFileSync(launcher, ['#!/bin/sh', 'rm -f "$0"', 'rmdir "$(dirname "$0")" 2>/dev/null', ...exports,
    `exec ${[launch.binary, ...launch.args].map(shellQuote).join(' ')}`, ''].join('\n'), { mode: 0o700 });
  chmodSync(launcher, 0o700);
  try {
    // history-limit applies to panes created after it is set, so it precedes new-session in one command list.
    // remain-on-exit keeps this window's dead pane, so its exit status tells a crash from a normal exit
    // (session resume). It is set on this window only, in the same command list, before the server
    // returns to its event loop, so even a process that exits at once is kept.
    tmuxOrThrow(['set-option', '-g', 'history-limit', String(HISTORY_LIMIT), ';', 'new-session', '-d', '-s', tmuxSessionName(agentId), '-x', '220', '-y', '50', '-c', launch.cwd, shellQuote(launcher),
      ...(remainOnExit ? [';', 'set-option', '-w', '-t', target(agentId), 'remain-on-exit', 'on'] : [])],
      { env: stripNestedProviderEnv(process.env) as Record<string, string> });
  } catch (error) {
    rmSync(dirname(launcher), { recursive: true, force: true });
    throw error;
  }
  tmux(['pipe-pane', '-o', '-t', target(agentId), `cat >> ${shellQuote(logPath(agentId))}`]);
  return dirname(launcher);
}

function startedSession(agentId: string, provider: string, binary: string) {
  const started = inspect(agentId);
  return {
    session_handle: `tmux:${agentId}`,
    provider_ref: {
      pid: started.pid, provider, binary, transport: 'tmux',
      process_start: started.processStart, tmux_socket: tmuxSocketName(), tmux_session: tmuxSessionName(agentId),
    },
  };
}

/** How long a fresh pane gets to run (and so delete) its launcher. */
const LAUNCHER_RUN_WAIT_MS = 5_000;

/**
 * Starts `launch` as a detached session for `agentId` on orc's private server,
 * the same launcher path as a worker but with no startup dialogs: the master
 * (task v1/master-tmux) answers its own once someone attaches. The secret in
 * `launch.env` reaches the process only through the self-deleting launcher.
 */
export function startTmuxSession(agentId: string, launch: TmuxLaunch, provider: string) {
  const launcherDir = openSession(agentId, launch);
  try {
    // Removing the launcher before the pane has read it would fail the start.
    const deadline = Date.now() + LAUNCHER_RUN_WAIT_MS;
    while (existsSync(join(launcherDir, `${agentId}.launch.sh`)) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SERVER_EXIT_POLL_MS);
    }
    const started = inspect(agentId);
    if (!started.alive || started.pid == null) throw new Error(`tmux session for ${agentId} exited during startup`);
  } finally {
    rmSync(launcherDir, { recursive: true, force: true });
  }
  return startedSession(agentId, provider, launch.binary);
}

/** Liveness of the session started for `agentId`. */
export function inspectTmuxSession(agentId: string): SessionInspection {
  return inspect(agentId);
}

export function createTmuxAdapter({ provider = 'claude' }: { provider?: string } = {}) {
  return {
    async start(agentId: string, config: Record<string, unknown> = {}) {
      const launch = prepareProviderLaunch(provider, agentId, config);
      // Only a worker window keeps its dead pane: its exit status decides a session resume.
      const launcherDir = openSession(agentId, launch, { remainOnExit: true });
      try {
        const started = inspect(agentId);
        if (!started.alive || started.pid == null) throw new Error(`tmux session for ${agentId} exited during startup`);
        await runStartupDialogs((text) => write(agentId, text), provider, config, () => capture(agentId) ?? readLogTail(agentId));
      } finally {
        // The launcher removes itself when it runs; if the pane never ran it, its secrets must not linger.
        rmSync(launcherDir, { recursive: true, force: true });
      }
      return startedSession(agentId, provider, launch.binary);
    },

    async send(sessionHandle: string, text: string) {
      const agentId = parseHandle(sessionHandle);
      if (!inspect(agentId).alive) throw new Error(`No live tmux session for agent '${agentId}'`);
      const marker = markCoordinatorSend(agentId);
      try {
        write(agentId, String(text));
        await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
        write(agentId, '\r');
        return '';
      } finally {
        clearCoordinatorSend(marker);
      }
    },

    /** Any process on this host user can write to the tmux session. */
    ownsSession(sessionHandle: string) {
      try { return inspect(parseHandle(sessionHandle)).alive; } catch { return false; }
    },

    survivesCoordinatorExit(sessionHandle: string) {
      return String(sessionHandle).startsWith('tmux:');
    },

    exitStatus(sessionHandle: string): SessionExitStatus | null {
      try { return exitStatus(parseHandle(sessionHandle)); } catch { return null; }
    },

    inspectSession(sessionHandle: string): SessionInspection {
      return inspect(parseHandle(sessionHandle));
    },

    detectInputBlock(sessionHandle: string, hookEvents: Array<{ message?: string }> = []) {
      try {
        const agentId = parseHandle(sessionHandle);
        // Permission hook events come from the coordinator tick, the hook file's only reader.
        if (hookEvents.length > 0) return hookEvents[0].message || 'permission prompt detected';
        return detectBlockingPromptFromText(capture(agentId) ?? stripAnsi(readLogTail(agentId)));
      } catch {
        return null;
      }
    },

    getOutputTail(sessionHandle: string, maxBytes?: number): string | null {
      try {
        const agentId = parseHandle(sessionHandle);
        // The pane, not the raw log, is the source while the session lives: a TUI
        // redraws with cursor moves, so the stripped log loses its line breaks.
        // A caller asking for a long tail reads that much pane history; the log
        // is only the fallback once the pane is gone.
        const lines = maxBytes === undefined ? CAPTURE_LINES : Math.max(CAPTURE_LINES, Math.ceil(maxBytes / BYTES_PER_CAPTURE_LINE));
        const text = capture(agentId, lines) ?? stripAnsi(readLogTail(agentId, maxBytes));
        return text.slice(-(maxBytes ?? OUTPUT_TAIL_BYTES)).trim();
      } catch {
        return null;
      }
    },

    attach(sessionHandle: string) {
      try {
        const agentId = parseHandle(sessionHandle);
        const text = capture(agentId);
        if (text != null) { console.log(text); return; }
        if (!existsSync(logPath(agentId))) { console.log('(no output log — agent session not yet started)'); return; }
        console.log(stripAnsi(readLogTail(agentId)));
      } catch {
        console.log('(could not read tmux session output)');
      }
    },

    heartbeatProbe(sessionHandle: string): Promise<boolean> {
      try { return Promise.resolve(inspect(parseHandle(sessionHandle)).alive); } catch { return Promise.resolve(false); }
    },

    stop(sessionHandle: string): Promise<void> {
      try {
        const agentId = parseHandle(sessionHandle);
        tmux(['kill-session', '-t', target(agentId)]);
        // The server exits with its last session; its socket file would stay behind.
        removeDeadTmuxSocket(tmuxSocketName(), { waitMs: SERVER_EXIT_WAIT_MS });
        for (const path of [hookEventPath(agentId), `${hookEventPath(agentId)}.processing`, taskLabelsPath(hookEventPath(agentId)), settingsPath(agentId)]) {
          try { unlinkSync(path); } catch { /* already gone or never created */ }
        }
      } catch {
        // No-op — malformed handle or session already gone.
      }
      return Promise.resolve();
    },
  };
}
