import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { tmuxSessionName, tmuxSocketName } from '../adapters/tmux.ts';
import { ControlError } from './controlProtocol.ts';
import { withEventDb, withEventDbTransaction } from './eventLog.ts';
import { getRunWorktree } from './runWorktree.ts';

export type TerminalKind = 'provider' | 'shell';
export interface TerminalRecord {
  terminal_id: string;
  run_id: string;
  kind: TerminalKind;
  handle: string;
  worktree_path: string;
  log_path: string;
  state: 'running' | 'offline';
  created_at: string;
  updated_at: string;
}

/** The broker owns all writes. Implementations must be usable from another process. */
export interface TerminalDriver {
  startShell(handle: string, cwd: string, logPath: string): boolean;
  alive(handle: string): boolean;
  capture(handle: string): string;
  input(handle: string, data: string): void;
  resize(handle: string, columns: number, rows: number): void;
  stop(handle: string): void;
}

function shellName(runId: string): string {
  return `orc-shell-${createHash('sha256').update(runId).digest('hex').slice(0, 20)}`;
}

export function terminalInputTokens(data: string): Array<{ key?: string; text?: string }> {
  const special: Record<string, string> = {
    '\r': 'Enter', '\n': 'Enter', '\t': 'Tab', '\x1b': 'Escape', '\x7f': 'BSpace',
    '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
    '\x1b[H': 'Home', '\x1b[F': 'End', '\x1b[2~': 'Insert', '\x1b[3~': 'Delete',
    '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown',
    '\x1bOP': 'F1', '\x1bOQ': 'F2', '\x1bOR': 'F3', '\x1bOS': 'F4',
    '\x1b[15~': 'F5', '\x1b[17~': 'F6', '\x1b[18~': 'F7', '\x1b[19~': 'F8',
    '\x1b[20~': 'F9', '\x1b[21~': 'F10', '\x1b[23~': 'F11', '\x1b[24~': 'F12',
  };
  return data.split(/(\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[A-Za-z]|\x1b.|[\x00-\x1f\x7f])/g)
    .filter(Boolean).map((part) => {
      const code = part.length === 1 ? part.charCodeAt(0) : -1;
      const key = special[part] ?? (code >= 1 && code <= 26 ? `C-${String.fromCharCode(96 + code)}`
        : code === 0 ? 'C-Space' : code === 28 ? 'C-\\' : code === 29 ? 'C-]'
          : code === 30 ? 'C-^' : code === 31 ? 'C-_' : undefined);
      return key ? { key } : { text: part };
    });
}

/** The same private tmux server as the provider adapter, with distinct shell names. */
export class TmuxTerminalDriver implements TerminalDriver {
  private readonly stateDir: string;
  constructor(stateDir: string) { this.stateDir = stateDir; }

  private name(handle: string): string {
    if (handle.startsWith('tmux:')) return tmuxSessionName(handle.slice(5));
    if (handle.startsWith('shell:')) return shellName(handle.slice(6));
    throw new ControlError('bad_request', 'Unsupported terminal handle', 400);
  }

  private run(args: string[], input?: string): string {
    const result = spawnSync(process.env.ORC_TMUX_BIN ?? 'tmux', ['-L', tmuxSocketName(this.stateDir), ...args], {
      encoding: 'utf8', timeout: 10_000, ...(input === undefined ? {} : { input }),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`tmux ${args[0]} failed: ${(result.stderr || '').trim()}`);
    return result.stdout;
  }

  private target(handle: string): string { return `=${this.name(handle)}:`; }

  startShell(handle: string, cwd: string, logPath: string): boolean {
    if (this.alive(handle)) return false;
    this.run(['new-session', '-d', '-s', this.name(handle), '-x', '100', '-y', '30', '-c', cwd, '/bin/bash']);
    try { this.run(['pipe-pane', '-o', '-t', this.target(handle), `cat >> '${logPath.replace(/'/g, `'\\''`)}'`]); }
    catch (error) { this.stop(handle); throw error; }
    return true;
  }

  alive(handle: string): boolean {
    try { return this.run(['display-message', '-p', '-t', this.target(handle), '#{pane_dead}']).trim() === '0'; }
    catch { return false; }
  }

  capture(handle: string): string {
    try { return this.run(['capture-pane', '-p', '-J', '-S', '-200', '-t', this.target(handle)]); }
    catch { return ''; }
  }

  input(handle: string, data: string): void {
    if (!data) return;
    for (const token of terminalInputTokens(data)) {
      if (token.key) this.run(['send-keys', '-t', this.target(handle), token.key]);
      else {
        const buffer = `${this.name(handle)}-input`;
        this.run(['load-buffer', '-b', buffer, '-'], token.text);
        this.run(['paste-buffer', '-d', '-p', '-b', buffer, '-t', this.target(handle)]);
      }
    }
  }

  resize(handle: string, columns: number, rows: number): void {
    this.run(['resize-window', '-t', this.target(handle), '-x', String(columns), '-y', String(rows)]);
  }

  stop(handle: string): void {
    try { this.run(['kill-session', '-t', this.target(handle)]); } catch { /* already exited */ }
  }
}

const DEFAULT_LEASE_MS = 30_000;
const MAX_READ_BYTES = 64 * 1024;

export class TerminalBroker {
  private readonly stateDir: string;
  private readonly driver: TerminalDriver;
  private readonly worktreeForRun: (runId: string) => string | null;

  constructor(stateDir: string, options: {
    driver?: TerminalDriver;
    worktreeForRun?: (runId: string) => string | null;
  } = {}) {
    this.stateDir = stateDir;
    this.driver = options.driver ?? new TmuxTerminalDriver(stateDir);
    this.worktreeForRun = options.worktreeForRun ?? ((runId) => getRunWorktree(stateDir, runId)?.worktree_path ?? null);
  }

  private worktree(runId: string): string {
    const path = this.worktreeForRun(runId);
    if (!path || !existsSync(join(path, '.git'))) throw new ControlError('not_found', `No assigned worktree for run ${runId}`, 404);
    return path;
  }

  private row(terminalId: string): TerminalRecord {
    const row = withEventDb(this.stateDir, (db) => db.prepare('SELECT * FROM terminals WHERE terminal_id = ?').get(terminalId) as TerminalRecord | undefined);
    if (!row) throw new ControlError('not_found', `Terminal ${terminalId} not found`, 404);
    return row;
  }

  private isCurrent(db: Database.Database, terminal: TerminalRecord): boolean {
    const run = db.prepare('SELECT state FROM runs WHERE run_id = ?').get(terminal.run_id) as { state: string } | undefined;
    if (!run || !['claimed', 'in_progress'].includes(run.state)) return false;
    if (terminal.kind === 'shell') return true;
    const agentId = terminal.handle.startsWith('tmux:') ? terminal.handle.slice(5) : '';
    if (!agentId) return false;
    const session = db.prepare(`SELECT run_id, state, transport FROM sessions WHERE agent_id = ?
      ORDER BY rowid DESC LIMIT 1`).get(agentId) as { run_id: string; state: string; transport: string | null } | undefined;
    return session?.run_id === terminal.run_id && session.state === 'running' && session.transport === 'tmux';
  }

  private available(terminal: TerminalRecord): boolean {
    return terminal.state === 'running' && withEventDb(this.stateDir, (db) => this.isCurrent(db, terminal))
      && this.driver.alive(terminal.handle);
  }

  private save(runId: string, kind: TerminalKind, handle: string, logPath: string): TerminalRecord {
    const path = this.worktree(runId);
    const terminalId = `${kind}:${runId}`;
    const now = new Date().toISOString();
    return withEventDbTransaction(this.stateDir, (db) => {
      const run = db.prepare('SELECT state FROM runs WHERE run_id = ?').get(runId) as { state: string } | undefined;
      if (!run || !['claimed', 'in_progress'].includes(run.state)) throw new ControlError('conflict', 'Run is not active', 409);
      if (kind === 'provider' && !this.isCurrent(db, { run_id: runId, kind, handle } as TerminalRecord))
        throw new ControlError('conflict', 'Provider session no longer belongs to this run', 409);
      db.prepare(`INSERT INTO terminals (terminal_id, run_id, kind, handle, worktree_path, log_path, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
        ON CONFLICT (terminal_id) DO UPDATE SET handle = excluded.handle, worktree_path = excluded.worktree_path,
          log_path = excluded.log_path, state = 'running', updated_at = excluded.updated_at`)
        .run(terminalId, runId, kind, handle, path, logPath, now, now);
      return db.prepare('SELECT * FROM terminals WHERE terminal_id = ?').get(terminalId) as TerminalRecord;
    });
  }

  provider(runId: string): TerminalRecord {
    const session = withEventDb(this.stateDir, (db) => db.prepare(`SELECT agent_id, transport FROM sessions
      WHERE run_id = ? AND state = 'running' ORDER BY rowid DESC LIMIT 1`).get(runId) as { agent_id: string; transport: string | null } | undefined);
    if (!session || session.transport !== 'tmux') throw new ControlError('conflict', 'Run has no tmux provider terminal', 409);
    const handle = `tmux:${session.agent_id}`;
    const candidate = { run_id: runId, kind: 'provider', handle } as TerminalRecord;
    if (!withEventDb(this.stateDir, (db) => this.isCurrent(db, candidate)))
      throw new ControlError('conflict', 'Provider session no longer belongs to this run', 409);
    if (!this.driver.alive(handle)) throw new ControlError('unavailable', 'Provider terminal is not running', 503);
    return this.save(runId, 'provider', handle, join(this.stateDir, 'pty-logs', `${session.agent_id}.log`));
  }

  shell(runId: string): TerminalRecord {
    const path = this.worktree(runId);
    const handle = `shell:${runId}`;
    const logDir = join(this.stateDir, 'terminal-logs');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = join(logDir, `${shellName(runId)}.log`);
    const run = withEventDb(this.stateDir, (db) => db.prepare('SELECT state FROM runs WHERE run_id = ?').get(runId) as { state: string } | undefined);
    if (!run || !['claimed', 'in_progress'].includes(run.state)) throw new ControlError('conflict', 'Run is not active', 409);
    if (!this.driver.alive(handle)) this.markOffline(`shell:${runId}`);
    const started = this.driver.startShell(handle, path, logPath);
    if (!this.driver.alive(handle)) throw new ControlError('unavailable', 'Worktree shell did not start', 503);
    try { return this.save(runId, 'shell', handle, logPath); }
    catch (error) { if (started) this.driver.stop(handle); throw error; }
  }

  observe(terminalId: string, after = 0): { terminal: TerminalRecord; screen: string; output: string; cursor: number } {
    if (!Number.isSafeInteger(after) || after < 0) throw new ControlError('bad_request', 'after must be a non-negative integer', 400);
    const terminal = this.row(terminalId);
    if (!this.available(terminal) && terminal.state !== 'offline') {
      this.markOffline(terminalId);
      terminal.state = 'offline';
    }
    let output = '';
    let cursor = after;
    if (existsSync(terminal.log_path)) {
      const size = statSync(terminal.log_path).size;
      const start = Math.min(after, size);
      const length = Math.min(size - start, MAX_READ_BYTES);
      if (length > 0) {
        const fd = openSync(terminal.log_path, 'r');
        try {
          const buffer = Buffer.alloc(length);
          readSync(fd, buffer, 0, length, start);
          output = buffer.toString('utf8');
        } finally { closeSync(fd); }
      }
      cursor = start + length;
    }
    return { terminal, screen: terminal.state === 'running' ? this.driver.capture(terminal.handle) : '', output, cursor };
  }

  acquire(terminalId: string, ownerId: string, ttlMs = DEFAULT_LEASE_MS): { lease_id: string; expires_at: string } {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 200) throw new ControlError('bad_request', 'owner_id is required', 400);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 120_000) throw new ControlError('bad_request', 'ttl_ms must be 1000–120000', 400);
    const terminal = this.row(terminalId);
    if (!this.available(terminal)) {
      this.markOffline(terminalId);
      throw new ControlError('unavailable', 'Terminal is not running', 503);
    }
    return withEventDbTransaction(this.stateDir, (db) => {
      if (!this.isCurrent(db, terminal)) throw new ControlError('unavailable', 'Terminal run is no longer active', 503);
      const now = Date.now();
      const current = db.prepare("SELECT lease_id, owner_id, expires_at FROM control_leases WHERE resource_type = 'terminal' AND resource_id = ?")
        .get(terminalId) as { lease_id: string; owner_id: string; expires_at: string } | undefined;
      if (current && Date.parse(current.expires_at) > now) throw new ControlError('conflict', 'Terminal already has a writer', 409);
      const leaseId = randomUUID();
      const expiresAt = new Date(now + ttlMs).toISOString();
      db.prepare(`INSERT INTO control_leases (resource_type, resource_id, lease_id, owner_id, expires_at)
        VALUES ('terminal', ?, ?, ?, ?) ON CONFLICT (resource_type, resource_id) DO UPDATE SET
          lease_id = excluded.lease_id, owner_id = excluded.owner_id, expires_at = excluded.expires_at`)
        .run(terminalId, leaseId, ownerId, expiresAt);
      return { lease_id: leaseId, expires_at: expiresAt };
    });
  }

  private withLease<T>(terminalId: string, leaseId: string, action: (terminal: TerminalRecord) => T): T {
    const terminal = this.row(terminalId);
    if (!this.available(terminal)) {
      this.markOffline(terminalId);
      throw new ControlError('unavailable', 'Terminal is not running', 503);
    }
    return withEventDbTransaction(this.stateDir, (db) => {
      if (!this.isCurrent(db, terminal)) throw new ControlError('unavailable', 'Terminal run is no longer active', 503);
      const lease = db.prepare("SELECT lease_id, expires_at FROM control_leases WHERE resource_type = 'terminal' AND resource_id = ?")
        .get(terminalId) as { lease_id: string; expires_at: string } | undefined;
      if (!lease || lease.lease_id !== leaseId || Date.parse(lease.expires_at) <= Date.now()) {
        throw new ControlError('forbidden', 'Valid terminal writer lease required', 403);
      }
      const result = action(terminal);
      db.prepare("UPDATE control_leases SET expires_at = ? WHERE resource_type = 'terminal' AND resource_id = ?")
        .run(new Date(Date.now() + DEFAULT_LEASE_MS).toISOString(), terminalId);
      return result;
    });
  }

  renew(terminalId: string, leaseId: string): void { this.withLease(terminalId, leaseId, () => undefined); }
  input(terminalId: string, leaseId: string, data: string): void {
    if (typeof data !== 'string' || data.length > 8192) throw new ControlError('bad_request', 'data must be at most 8192 characters', 400);
    this.withLease(terminalId, leaseId, (terminal) => this.driver.input(terminal.handle, data));
  }
  resize(terminalId: string, leaseId: string, columns: number, rows: number): void {
    if (!Number.isSafeInteger(columns) || columns < 20 || columns > 500 || !Number.isSafeInteger(rows) || rows < 5 || rows > 200)
      throw new ControlError('bad_request', 'Invalid terminal size', 400);
    this.withLease(terminalId, leaseId, (terminal) => this.driver.resize(terminal.handle, columns, rows));
  }
  release(terminalId: string, leaseId: string): void {
    this.row(terminalId);
    const removed = withEventDbTransaction(this.stateDir, (db) => db.prepare(`DELETE FROM control_leases
      WHERE resource_type = 'terminal' AND resource_id = ? AND lease_id = ?`).run(terminalId, leaseId).changes);
    if (!removed) throw new ControlError('forbidden', 'Valid terminal writer lease required', 403);
  }

  private markOffline(terminalId: string): void {
    withEventDbTransaction(this.stateDir, (db) => {
      db.prepare("UPDATE terminals SET state = 'offline', updated_at = ? WHERE terminal_id = ?")
        .run(new Date().toISOString(), terminalId);
      db.prepare("DELETE FROM control_leases WHERE resource_type = 'terminal' AND resource_id = ?").run(terminalId);
    });
  }

  /** Called by the daemon to clear expired owners and shells whose run ended. */
  reconcile(): void {
    const rows = withEventDb(this.stateDir, (db) => db.prepare(`SELECT t.*, r.state AS run_state FROM terminals t
      LEFT JOIN runs r ON r.run_id = t.run_id WHERE t.state = 'running'`).all() as Array<TerminalRecord & { run_state: string | null }>);
    for (const row of rows) {
      const active = row.run_state === 'claimed' || row.run_state === 'in_progress';
      if (row.kind === 'shell' && !active && this.driver.alive(row.handle)) this.driver.stop(row.handle);
      if (!this.available(row)) this.markOffline(row.terminal_id);
    }
    withEventDbTransaction(this.stateDir, (db) => db.prepare(`DELETE FROM control_leases
      WHERE resource_type = 'terminal' AND expires_at <= ?`).run(new Date().toISOString()));
  }
}
