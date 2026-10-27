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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_DIR, hookEventPath, consumeHookEvents } from '../lib/paths.ts';
import { stripAnsi } from '../lib/ansi.ts';
import { readProcessStart } from '../lib/processIdentity.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { withEventDbTransaction } from '../lib/eventLog.ts';
import { logger } from '../lib/logger.ts';
import { detectBlockingPromptFromText, prepareProviderLaunch, runStartupDialogs } from './pty.ts';
import type { SessionInspection } from './interface.ts';

const OUTPUT_TAIL_BYTES = 8 * 1024;
const CAPTURE_LINES = 200;
const SUBMIT_DELAY_MS = 200;

function tmuxBinary(): string { return process.env.ORC_TMUX_BIN ?? 'tmux'; }

/** One private tmux server per state dir; tmux keeps its sockets in a per-user 0700 directory. */
export function tmuxSocketName(stateDir = STATE_DIR): string {
  return `orc-${createHash('sha256').update(stateDir).digest('hex').slice(0, 12)}`;
}

/** Readable and injective: the hash keeps `a.b` and `a_b` from sharing a session. */
export function tmuxSessionName(agentId: string): string {
  const readable = agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `orc-${readable}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`;
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

export function isTmuxAvailable(): boolean {
  const result = spawnSync(tmuxBinary(), ['-V'], { encoding: 'utf8', timeout: 5_000 });
  return !result.error && result.status === 0;
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

function capture(agentId: string): string | null {
  const result = tmux(['capture-pane', '-p', '-J', '-S', `-${CAPTURE_LINES}`, '-t', target(agentId)]);
  return result.status === 0 ? result.stdout : null;
}

function readLogTail(agentId: string): string {
  const path = logPath(agentId);
  if (!existsSync(path)) return '';
  return readFileSync(path).subarray(-OUTPUT_TAIL_BYTES).toString('utf8');
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

/** Coordinator sends and operator input share the same persisted writer lease. */
function claimSendLease(agentId: string): { resourceId: string; leaseId: string } | null {
  if (!existsSync(join(STATE_DIR, 'events.db'))) return null;
  return withEventDbTransaction(STATE_DIR, (db) => {
    const session = db.prepare(`SELECT run_id FROM sessions WHERE agent_id = ? AND state = 'running'
      AND transport = 'tmux' ORDER BY rowid DESC LIMIT 1`).get(agentId) as { run_id: string | null } | undefined;
    if (!session?.run_id) return null;
    const resourceId = `provider:${session.run_id}`;
    const current = db.prepare("SELECT expires_at FROM control_leases WHERE resource_type = 'terminal' AND resource_id = ?")
      .get(resourceId) as { expires_at: string } | undefined;
    if (current && Date.parse(current.expires_at) > Date.now()) throw new Error('Terminal already has a writer');
    const leaseId = randomUUID();
    db.prepare(`INSERT INTO control_leases (resource_type, resource_id, lease_id, owner_id, expires_at)
      VALUES ('terminal', ?, ?, ?, ?) ON CONFLICT (resource_type, resource_id) DO UPDATE SET
        lease_id = excluded.lease_id, owner_id = excluded.owner_id, expires_at = excluded.expires_at`)
      .run(resourceId, leaseId, `coordinator:${process.pid}`, new Date(Date.now() + 30_000).toISOString());
    return { resourceId, leaseId };
  });
}

function releaseSendLease(lease: { resourceId: string; leaseId: string } | null): void {
  if (!lease) return;
  try {
    withEventDbTransaction(STATE_DIR, (db) => db.prepare(`DELETE FROM control_leases
      WHERE resource_type = 'terminal' AND resource_id = ? AND lease_id = ?`).run(lease.resourceId, lease.leaseId));
  } catch (error) {
    logger.warn(`[tmux] writer lease cleanup failed: ${(error as Error).message}`);
  }
}

export function createTmuxAdapter({ provider = 'claude' }: { provider?: string } = {}) {
  return {
    async start(agentId: string, config: Record<string, unknown> = {}) {
      const launch = prepareProviderLaunch(provider, agentId, config);
      tmux(['kill-session', '-t', target(agentId)]);
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
        tmuxOrThrow(['new-session', '-d', '-s', tmuxSessionName(agentId), '-x', '220', '-y', '50', '-c', launch.cwd, shellQuote(launcher)],
          { env: stripNestedProviderEnv(process.env) as Record<string, string> });
      } catch (error) {
        rmSync(dirname(launcher), { recursive: true, force: true });
        throw error;
      }
      tmux(['pipe-pane', '-o', '-t', target(agentId), `cat >> ${shellQuote(logPath(agentId))}`]);

      const started = inspect(agentId);
      if (!started.alive || started.pid == null) throw new Error(`tmux session for ${agentId} exited during startup`);
      await runStartupDialogs((text) => write(agentId, text), provider, config, () => capture(agentId) ?? readLogTail(agentId));

      return {
        session_handle: `tmux:${agentId}`,
        provider_ref: {
          pid: started.pid, provider, binary: launch.binary, transport: 'tmux',
          process_start: started.processStart, tmux_socket: tmuxSocketName(), tmux_session: tmuxSessionName(agentId),
        },
      };
    },

    async send(sessionHandle: string, text: string) {
      const agentId = parseHandle(sessionHandle);
      if (!inspect(agentId).alive) throw new Error(`No live tmux session for agent '${agentId}'`);
      const lease = claimSendLease(agentId);
      try {
        write(agentId, String(text));
        await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
        write(agentId, '\r');
        return '';
      } finally {
        releaseSendLease(lease);
      }
    },

    /** Any process on this host user can write to the tmux session. */
    ownsSession(sessionHandle: string) {
      try { return inspect(parseHandle(sessionHandle)).alive; } catch { return false; }
    },

    survivesCoordinatorExit(sessionHandle: string) {
      return String(sessionHandle).startsWith('tmux:');
    },

    inspectSession(sessionHandle: string): SessionInspection {
      return inspect(parseHandle(sessionHandle));
    },

    detectInputBlock(sessionHandle: string) {
      try {
        const agentId = parseHandle(sessionHandle);
        const events = consumeHookEvents(agentId);
        if (events.length > 0) return events[0].message || 'permission prompt detected';
        return detectBlockingPromptFromText(capture(agentId) ?? stripAnsi(readLogTail(agentId)));
      } catch {
        return null;
      }
    },

    getOutputTail(sessionHandle: string): string | null {
      try {
        const agentId = parseHandle(sessionHandle);
        const text = capture(agentId) ?? stripAnsi(readLogTail(agentId));
        return text.slice(-OUTPUT_TAIL_BYTES).trim();
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
        for (const path of [hookEventPath(agentId), `${hookEventPath(agentId)}.processing`, settingsPath(agentId)]) {
          try { unlinkSync(path); } catch { /* already gone or never created */ }
        }
      } catch {
        // No-op — malformed handle or session already gone.
      }
      return Promise.resolve();
    },
  };
}
