import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { tmuxSessionName, tmuxSocketName } from '../adapters/tmux.ts';
import { ControlError, type SessionTerminalView } from './controlProtocol.ts';
import { withEventDb, withEventDbTransaction } from './eventLog.ts';
import { getRunWorktree } from './runWorktree.ts';
import {
  TerminalStreams, TmuxControlParser,
  type TerminalConnection, type TerminalSnapshot, type TerminalSource, type TerminalViewer,
} from './terminalHost.ts';

export type TerminalKind = 'provider' | 'shell';
/** Ids are `<kind>:<session_id>`; rows from before schema 8 keep their `<kind>:<run_id>` id. */
export interface TerminalRecord {
  terminal_id: string;
  session_id: string | null;
  run_id: string | null;
  kind: TerminalKind;
  handle: string;
  worktree_path: string;
  log_path: string;
  state: 'running' | 'offline';
  created_at: string;
  updated_at: string;
}

/**
 * `control_leases.resource_type` of the marker the coordinator holds while it
 * sends to a provider terminal (`adapters/tmux.ts`). The send never waits for
 * the operator's lease; operator input during it gets a retryable `busy`.
 */
export const COORDINATOR_SEND_RESOURCE = 'terminal_send';

/** The broker owns all writes. Implementations must be usable from another process. */
export interface TerminalDriver extends TerminalSource {
  startShell(handle: string, cwd: string, logPath: string): boolean;
  alive(handle: string): boolean;
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

  snapshot(handle: string): TerminalSnapshot {
    try {
      const [x, y, columns, rows] = this.run(['display-message', '-p', '-t', this.target(handle),
        '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}']).trim().split(' ').map(Number);
      const screen = this.run(['capture-pane', '-e', '-p', '-t', this.target(handle)]);
      return { screen, cursor_x: x, cursor_y: y, columns, rows };
    } catch {
      throw new ControlError('unavailable', 'Terminal is not running', 503);
    }
  }

  /**
   * One `tmux -C` client attached to the session. `ignore-size` keeps the
   * client from resizing the window; only `resize()` sizes it.
   */
  connect(handle: string): TerminalConnection {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const child = spawn(process.env.ORC_TMUX_BIN ?? 'tmux',
      ['-L', tmuxSocketName(this.stateDir), '-C', 'attach-session', '-f', 'ignore-size', '-t', `=${this.name(handle)}`],
      { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const parser = new TmuxControlParser();
    const outputs: Array<(data: Buffer) => void> = [];
    const exits: Array<(reason: string) => void> = [];
    let done = false;
    const exit = (reason: string): void => {
      if (done) return;
      done = true;
      for (const listener of exits) listener(reason);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      for (const event of parser.push(chunk)) {
        if (done) return;
        if (event.type === 'output') for (const listener of outputs) listener(event.data);
        else exit(event.reason);
      }
    });
    child.stdin.on('error', () => { /* the client already exited; 'close' reports it */ });
    child.on('error', (error) => exit(`control client failed: ${error.message}`));
    child.on('close', () => exit('control client closed'));
    return {
      onOutput: (listener) => { outputs.push(listener); },
      onExit: (listener) => { exits.push(listener); },
      stop: () => {
        if (done && child.exitCode !== null) return;
        done = true;
        child.stdin.end();
        child.kill();
      },
    };
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

export interface StreamOptions { columns?: number; rows?: number; leaseId?: string }

function validateSize(columns: number, rows: number): void {
  if (!Number.isSafeInteger(columns) || columns < 20 || columns > 500 || !Number.isSafeInteger(rows) || rows < 5 || rows > 200)
    throw new ControlError('bad_request', 'Invalid terminal size', 400);
}

export class TerminalBroker {
  private readonly stateDir: string;
  private readonly driver: TerminalDriver;
  private readonly worktreeForRun: (runId: string) => string | null;
  private readonly streams: TerminalStreams;

  constructor(stateDir: string, options: {
    driver?: TerminalDriver;
    worktreeForRun?: (runId: string) => string | null;
    livenessMs?: number;
  } = {}) {
    this.stateDir = stateDir;
    this.driver = options.driver ?? new TmuxTerminalDriver(stateDir);
    this.worktreeForRun = options.worktreeForRun ?? ((runId) => getRunWorktree(stateDir, runId)?.worktree_path ?? null);
    this.streams = new TerminalStreams(this.driver, options.livenessMs === undefined ? {} : { livenessMs: options.livenessMs });
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
    // Pre-v8 rows have no session and are never current; a newer session retires the old id.
    if (terminal.session_id == null) return false;
    if (terminal.kind === 'shell') {
      const latest = db.prepare('SELECT session_id FROM sessions WHERE run_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(terminal.run_id) as { session_id: string } | undefined;
      return latest?.session_id === terminal.session_id;
    }
    const agentId = terminal.handle.startsWith('tmux:') ? terminal.handle.slice(5) : '';
    if (!agentId) return false;
    const session = db.prepare(`SELECT session_id, run_id, state, transport FROM sessions WHERE agent_id = ?
      ORDER BY rowid DESC LIMIT 1`).get(agentId) as { session_id: string; run_id: string; state: string; transport: string | null } | undefined;
    return session?.run_id === terminal.run_id && session.state === 'running' && session.transport === 'tmux'
      && terminal.session_id === session.session_id;
  }

  private available(terminal: TerminalRecord): boolean {
    return terminal.state === 'running' && withEventDb(this.stateDir, (db) => this.isCurrent(db, terminal))
      && this.driver.alive(terminal.handle);
  }

  private save(runId: string, sessionId: string, kind: TerminalKind, handle: string, logPath: string): TerminalRecord {
    const path = this.worktree(runId);
    const terminalId = `${kind}:${sessionId}`;
    const now = new Date().toISOString();
    return withEventDbTransaction(this.stateDir, (db) => {
      const run = db.prepare('SELECT state FROM runs WHERE run_id = ?').get(runId) as { state: string } | undefined;
      if (!run || !['claimed', 'in_progress'].includes(run.state)) throw new ControlError('conflict', 'Run is not active', 409);
      if (kind === 'provider' && !this.isCurrent(db, { session_id: sessionId, run_id: runId, kind, handle } as TerminalRecord))
        throw new ControlError('conflict', 'Provider session no longer belongs to this run', 409);
      db.prepare(`INSERT INTO terminals (terminal_id, session_id, run_id, kind, handle, worktree_path, log_path, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
        ON CONFLICT (terminal_id) DO UPDATE SET handle = excluded.handle, worktree_path = excluded.worktree_path,
          log_path = excluded.log_path, state = 'running', updated_at = excluded.updated_at`)
        .run(terminalId, sessionId, runId, kind, handle, path, logPath, now, now);
      return db.prepare('SELECT * FROM terminals WHERE terminal_id = ?').get(terminalId) as TerminalRecord;
    });
  }

  provider(runId: string): TerminalRecord {
    const session = withEventDb(this.stateDir, (db) => db.prepare(`SELECT session_id, agent_id, transport FROM sessions
      WHERE run_id = ? AND state = 'running' ORDER BY rowid DESC LIMIT 1`).get(runId) as { session_id: string; agent_id: string; transport: string | null } | undefined);
    if (!session || session.transport !== 'tmux') throw new ControlError('conflict', 'Run has no tmux provider terminal', 409);
    const handle = `tmux:${session.agent_id}`;
    const candidate = { session_id: session.session_id, run_id: runId, kind: 'provider', handle } as TerminalRecord;
    if (!withEventDb(this.stateDir, (db) => this.isCurrent(db, candidate)))
      throw new ControlError('conflict', 'Provider session no longer belongs to this run', 409);
    if (!this.driver.alive(handle)) throw new ControlError('unavailable', 'Provider terminal is not running', 503);
    return this.save(runId, session.session_id, 'provider', handle, join(this.stateDir, 'pty-logs', `${session.agent_id}.log`));
  }

  shell(runId: string): TerminalRecord {
    const path = this.worktree(runId);
    const handle = `shell:${runId}`;
    const logDir = join(this.stateDir, 'terminal-logs');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = join(logDir, `${shellName(runId)}.log`);
    const { run, session } = withEventDb(this.stateDir, (db) => ({
      run: db.prepare('SELECT state FROM runs WHERE run_id = ?').get(runId) as { state: string } | undefined,
      // The shell belongs to the run's worktree; it is recorded under the run's latest session.
      session: db.prepare('SELECT session_id FROM sessions WHERE run_id = ? ORDER BY rowid DESC LIMIT 1').get(runId) as { session_id: string } | undefined,
    }));
    if (!run || !['claimed', 'in_progress'].includes(run.state)) throw new ControlError('conflict', 'Run is not active', 409);
    if (!session) throw new ControlError('conflict', 'Run has no session', 409);
    if (!this.driver.alive(handle)) this.markOffline(`shell:${session.session_id}`);
    const started = this.driver.startShell(handle, path, logPath);
    if (!this.driver.alive(handle)) throw new ControlError('unavailable', 'Worktree shell did not start', 503);
    try { return this.save(runId, session.session_id, 'shell', handle, logPath); }
    catch (error) { if (started) this.driver.stop(handle); throw error; }
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

  private withLease<T>(terminalId: string, leaseId: string, action: (terminal: TerminalRecord, db: Database.Database) => T): T {
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
      const result = action(terminal, db);
      db.prepare("UPDATE control_leases SET expires_at = ? WHERE resource_type = 'terminal' AND resource_id = ?")
        .run(new Date(Date.now() + DEFAULT_LEASE_MS).toISOString(), terminalId);
      return result;
    });
  }

  renew(terminalId: string, leaseId: string): void { this.withLease(terminalId, leaseId, () => undefined); }
  input(terminalId: string, leaseId: string, data: string): void {
    if (typeof data !== 'string' || data.length > 8192) throw new ControlError('bad_request', 'data must be at most 8192 characters', 400);
    this.withLease(terminalId, leaseId, (terminal, db) => {
      const send = db.prepare('SELECT expires_at FROM control_leases WHERE resource_type = ? AND resource_id = ?')
        .get(COORDINATOR_SEND_RESOURCE, terminalId) as { expires_at: string } | undefined;
      if (send && Date.parse(send.expires_at) > Date.now()) throw new ControlError('busy', 'The coordinator is sending to this terminal; retry shortly', 409);
      this.driver.input(terminal.handle, data);
    });
  }
  resize(terminalId: string, leaseId: string, columns: number, rows: number): void {
    validateSize(columns, rows);
    this.withLease(terminalId, leaseId, (terminal) => this.driver.resize(terminal.handle, columns, rows));
  }
  release(terminalId: string, leaseId: string): void {
    this.row(terminalId);
    const removed = withEventDbTransaction(this.stateDir, (db) => db.prepare(`DELETE FROM control_leases
      WHERE resource_type = 'terminal' AND resource_id = ? AND lease_id = ?`).run(terminalId, leaseId).changes);
    if (!removed) throw new ControlError('forbidden', 'Valid terminal writer lease required', 403);
  }

  /** Running sessions; `terminal_id` names the ones that have a live provider terminal to stream. */
  sessions(): SessionTerminalView[] {
    return withEventDb(this.stateDir, (db) => {
      const rows = db.prepare(`SELECT session_id, agent_id, run_id, provider, transport FROM sessions
        WHERE state = 'running' ORDER BY rowid`).all() as Array<Omit<SessionTerminalView, 'terminal_id'>>;
      return rows.map((row) => {
        const handle = `tmux:${row.agent_id}`;
        const candidate = { session_id: row.session_id, run_id: row.run_id, kind: 'provider', handle } as TerminalRecord;
        const streamable = row.transport === 'tmux' && row.run_id != null && this.isCurrent(db, candidate);
        return { ...row, terminal_id: streamable ? `provider:${row.session_id}` : null };
      });
    }).map((view) => (view.terminal_id && !this.driver.alive(`tmux:${view.agent_id}`) ? { ...view, terminal_id: null } : view));
  }

  /**
   * The terminal a stream opens. A provider id resolves through its session, so
   * listing sessions is enough to open one; a session without a tmux terminal
   * (an `app:` session) is `not_found`.
   */
  private streamTarget(terminalId: string): TerminalRecord {
    if (terminalId.startsWith('provider:')) {
      const session = withEventDb(this.stateDir, (db) => db.prepare('SELECT run_id, transport FROM sessions WHERE session_id = ?')
        .get(terminalId.slice('provider:'.length)) as { run_id: string | null; transport: string | null } | undefined);
      if (!session || session.transport !== 'tmux' || !session.run_id) throw new ControlError('not_found', `Terminal ${terminalId} not found`, 404);
      const terminal = this.provider(session.run_id);
      if (terminal.terminal_id !== terminalId) throw new ControlError('unavailable', 'Terminal session is no longer current', 503);
      return terminal;
    }
    const terminal = this.row(terminalId);
    if (!this.available(terminal)) {
      this.markOffline(terminalId);
      throw new ControlError('unavailable', 'Terminal is not running', 503);
    }
    return terminal;
  }

  /**
   * Opens a live stream: `snapshot`, then `output` frames, until `exit`. With a
   * size, the viewer that holds the input lease (`leaseId`), or the first
   * viewer when nobody holds it, sizes the pane; a resize to one column less
   * and back makes the TUI redraw. Returns the function that closes the stream.
   */
  stream(terminalId: string, viewer: TerminalViewer, options: StreamOptions = {}): () => void {
    const sized = options.columns !== undefined || options.rows !== undefined;
    if (sized) validateSize(Number(options.columns), Number(options.rows));
    const terminal = this.streamTarget(terminalId);
    const lease = withEventDb(this.stateDir, (db) => db.prepare("SELECT lease_id, expires_at FROM control_leases WHERE resource_type = 'terminal' AND resource_id = ?")
      .get(terminal.terminal_id) as { lease_id: string; expires_at: string } | undefined);
    const leased = lease !== undefined && Date.parse(lease.expires_at) > Date.now();
    if (options.leaseId !== undefined && (!leased || lease.lease_id !== options.leaseId))
      throw new ControlError('forbidden', 'Valid terminal writer lease required', 403);
    const sizer = sized && (options.leaseId !== undefined || (!leased && this.streams.viewers(terminal.handle) === 0));
    const close = this.streams.open(terminal.handle, viewer);
    if (sizer) {
      try {
        this.driver.resize(terminal.handle, options.columns! - 1, options.rows!);
        this.driver.resize(terminal.handle, options.columns!, options.rows!);
      } catch { /* the stream works at the current size */ }
    }
    return close;
  }

  /** Ends every open stream with an `exit` frame. */
  close(): void { this.streams.close(); }

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
