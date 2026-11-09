import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDb, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { ControlClient } from './controlClient.ts';
import { startControlServer, type ControlServer } from './controlServer.ts';
import { CONTROL_TOKEN_FILE, OPERATOR_HEADER, OPERATOR_TOKEN_FILE, type TerminalFrame } from './controlProtocol.ts';
import { TerminalBroker, TmuxTerminalDriver, terminalInputTokens, type TerminalDriver } from './terminalBroker.ts';
import type { TerminalConnection, TerminalSnapshot } from './terminalHost.ts';

const exec = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..');
let dir: string;
let server: ControlServer;
let broker: TerminalBroker;
let driver: FakeDriver;
let worktree: string;

class FakeConnection implements TerminalConnection {
  readonly handle: string;
  stopped = false;
  private outputs: Array<(data: Buffer) => void> = [];
  private exits: Array<(reason: string) => void> = [];
  private resizes: Array<(columns: number, rows: number) => void> = [];
  constructor(handle: string) { this.handle = handle; }
  onOutput(listener: (data: Buffer) => void): void { this.outputs.push(listener); }
  onResize(listener: (columns: number, rows: number) => void): void { this.resizes.push(listener); }
  onExit(listener: (reason: string) => void): void { this.exits.push(listener); }
  emit(text: string): void { for (const listener of this.outputs) listener(Buffer.from(text)); }
  exit(reason: string): void { for (const listener of this.exits) listener(reason); }
  resize(columns: number, rows: number): void { for (const listener of this.resizes) listener(columns, rows); }
  stop(): void { this.stopped = true; }
}

class FakeDriver implements TerminalDriver {
  live = new Set(['tmux:worker-a']);
  connections: FakeConnection[] = [];
  writes: Array<{ handle: string; data: string }> = [];
  sizes: Array<{ handle: string; columns: number; rows: number }> = [];
  logs = new Map<string, string>();
  startShell(handle: string, cwd: string, logPath: string): boolean {
    if (this.live.has(handle)) return false;
    expect(cwd).toBe(worktree);
    this.live.add(handle);
    this.logs.set(handle, logPath);
    writeFileSync(logPath, 'shell started\n');
    return true;
  }
  alive(handle: string): boolean { return this.live.has(handle); }
  snapshot(handle: string): TerminalSnapshot {
    return { screen: `screen:${handle}\n`, cursor_x: 3, cursor_y: 1, columns: 100, rows: 30 };
  }
  connect(handle: string): TerminalConnection {
    const connection = new FakeConnection(handle);
    this.connections.push(connection);
    return connection;
  }
  input(handle: string, data: string): void {
    this.writes.push({ handle, data });
    const log = this.logs.get(handle);
    if (log) appendFileSync(log, data);
  }
  resize(handle: string, columns: number, rows: number): void { this.sizes.push({ handle, columns, rows }); }
  stop(handle: string): void { this.live.delete(handle); }
}

beforeEach(async () => {
  dir = createTempStateDir('orch-terminal-');
  worktree = join(dir, 'worktree');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: dummy');
  seedState(dir);
  initEventsDb(dir);
  commitClaims(dir, { version: '1', claims: [
    { run_id: 'run-a', task_ref: 'orch/a', agent_id: 'worker-a', state: 'in_progress', claimed_at: '2026-01-01', started_at: '2026-01-01', lease_expires_at: '2099-01-01' },
    { run_id: 'run-b', task_ref: 'orch/b', agent_id: 'worker-b', state: 'in_progress', claimed_at: '2026-01-01', started_at: '2026-01-01', lease_expires_at: '2099-01-01' },
  ] });
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at)
      VALUES ('session-a', 'run-a', 'worker-a', 'claude', 'running', 'tmux', '2026-01-01', '2026-01-01'),
        ('session-b', 'run-b', 'worker-b', 'codex', 'running', 'app-server', '2026-01-01', '2026-01-01')`).run();
  });
  driver = new FakeDriver();
  broker = new TerminalBroker(dir, { driver, worktreeForRun: () => worktree });
  server = await startControlServer(dir, { terminals: broker });
});

/** Opens a stream and collects its frames; `next(n)` waits until `n` frames have arrived. */
function openStream(client: ControlClient, terminalId: string, options: { leaseId?: string; columns?: number; rows?: number } = {}) {
  const abort = new AbortController();
  const frames: TerminalFrame[] = [];
  let failure: Error | null = null;
  const done = (async () => {
    try { for await (const frame of client.streamTerminal(terminalId, options, abort.signal)) frames.push(frame); }
    catch (error) { failure = error as Error; }
  })();
  const next = async (count: number): Promise<TerminalFrame[]> => {
    const deadline = Date.now() + 3000;
    while (frames.length < count) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error(`expected ${count} frames, got ${JSON.stringify(frames)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return frames;
  };
  return { frames, next, done, close: async () => { abort.abort(); await done; }, failure: () => failure };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const terminalState = (id: string) => withEventDb(dir, (db) => (db.prepare('SELECT state FROM terminals WHERE terminal_id = ?').get(id) as { state: string }).state);

afterEach(async () => {
  await server.close();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('terminal broker', () => {
  it('sends a resize frame to every viewer', async () => {
    const client = new ControlClient(dir);
    const { terminal } = await client.openTerminal('provider', 'run-a');
    const one = openStream(client, terminal.terminal_id);
    const two = openStream(client, terminal.terminal_id);
    await one.next(1);
    await two.next(1);
    driver.connections[0].resize(120, 40);
    expect((await one.next(2))[1]).toEqual({ type: 'resize', columns: 120, rows: 40 });
    expect((await two.next(2))[1]).toEqual({ type: 'resize', columns: 120, rows: 40 });
    await one.close();
    await two.close();
  });

  it('ends a viewer that falls too far behind with an exit frame', async () => {
    const { terminal } = await new ControlClient(dir).openTerminal('provider', 'run-a');
    const token = readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8');
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: server.endpoint.path, path: `/v1/terminals/${encodeURIComponent(terminal.terminal_id)}/stream`,
        headers: { 'x-orc-protocol': '1', authorization: `Bearer ${token}`, [OPERATOR_HEADER]: readFileSync(join(dir, OPERATOR_TOKEN_FILE), 'utf8').trim() } }, resolve);
      req.on('error', reject);
      req.end();
    });
    res.pause();
    await waitFor(() => driver.connections.length === 1);
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 24; i++) driver.connections[0].emit(chunk);
    res.resume();
    let text = '';
    for await (const part of res) text += (part as Buffer).toString('utf8');
    const last = JSON.parse(text.trimEnd().split('\n').at(-1)!) as TerminalFrame;
    expect(last).toEqual({ type: 'exit', reason: 'backlog' });
  });

  it('passes common control and function keys as tmux keys while pasting printable text', () => {
    expect(terminalInputTokens('abc\t\x04\x03\x1b[A\x1bOP\x1b[15~\r')).toEqual([
      { text: 'abc' }, { key: 'Tab' }, { key: 'C-d' }, { key: 'C-c' },
      { key: 'Up' }, { key: 'F1' }, { key: 'F5' }, { key: 'Enter' },
    ]);
  });
  it('lets another process view a provider without acquiring input or ending the session', async () => {
    const observer = new ControlClient(dir);
    const terminal = (await observer.openTerminal('provider', 'run-a')).terminal;
    const view = openStream(observer, terminal.terminal_id);
    expect((await view.next(1))[0]).toMatchObject({ type: 'snapshot', screen: 'screen:tmux:worker-a\n' });
    await view.close();
    expect(terminal).toMatchObject({ terminal_id: 'provider:session-a', session_id: 'session-a', run_id: 'run-a' });
    const child = await exec(process.execPath, ['cli/terminal.ts', 'provider', 'run-a', '--once'], {
      cwd: repoRoot, env: { ...process.env, ORC_STATE_DIR: dir }, encoding: 'utf8',
    });
    expect(child.stdout).toContain('screen:tmux:worker-a');
    expect(driver.live.has('tmux:worker-a')).toBe(true);
  });

  it('grants one writer at a time, requires its lease for input and resize, and expires abandoned leases', async () => {
    const first = new ControlClient(dir);
    const second = new ControlClient(dir);
    const id = (await first.openTerminal('provider', 'run-a')).terminal.terminal_id;
    const lease = await first.acquireTerminal(id, 'first');
    await expect(second.acquireTerminal(id, 'second')).rejects.toMatchObject({ code: 'conflict' });
    await expect(second.inputTerminal(id, 'wrong', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await first.inputTerminal(id, lease.lease_id, 'a');
    await first.resizeTerminal(id, lease.lease_id, 100, 40);
    expect(driver.writes).toEqual([{ handle: 'tmux:worker-a', data: 'a' }]);
    expect(driver.sizes).toEqual([{ handle: 'tmux:worker-a', columns: 100, rows: 40 }]);
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE control_leases SET expires_at = '2000-01-01' WHERE resource_id = ?").run(id));
    const replacement = await second.acquireTerminal(id, 'second');
    await expect(first.inputTerminal(id, lease.lease_id, 'b')).rejects.toMatchObject({ code: 'forbidden' });
    await second.releaseTerminal(id, replacement.lease_id);
    expect(driver.live.has('tmux:worker-a')).toBe(true);
    await expect(first.acquireTerminal(id, 'first')).resolves.toHaveProperty('lease_id');
  });

  it('keeps an independent shell usable for a structured run after broker restart', async () => {
    const client = new ControlClient(dir);
    await expect(client.openTerminal('provider', 'run-b')).rejects.toMatchObject({ code: 'conflict' });
    const terminal = (await client.openTerminal('shell', 'run-b')).terminal;
    expect(terminal).toMatchObject({ terminal_id: 'shell:session-b', session_id: 'session-b', run_id: 'run-b', handle: 'shell:run-b' });
    const lease = await client.acquireTerminal(terminal.terminal_id, 'operator');
    await client.inputTerminal(terminal.terminal_id, lease.lease_id, 'pwd\r');
    await client.releaseTerminal(terminal.terminal_id, lease.lease_id);
    const restarted = new TerminalBroker(dir, { driver, worktreeForRun: () => worktree });
    expect(driver.writes).toEqual([{ handle: 'shell:run-b', data: 'pwd\r' }]);
    expect(terminal.worktree_path).toBe(worktree);
    const view = openStream(client, terminal.terminal_id);
    expect((await view.next(1))[0]).toMatchObject({ type: 'snapshot', screen: 'screen:shell:run-b\n' });
    await view.close();
    expect(driver.live.has('shell:run-b')).toBe(true);
    const oldLease = await client.acquireTerminal(terminal.terminal_id, 'old-writer');
    driver.live.delete('shell:run-b');
    await client.openTerminal('shell', 'run-b');
    await expect(client.inputTerminal(terminal.terminal_id, oldLease.lease_id, 'x')).rejects.toMatchObject({ code: 'forbidden' });
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE runs SET state = 'done' WHERE run_id = 'run-b'").run());
    restarted.reconcile();
    expect(driver.live.has('shell:run-b')).toBe(false);
    expect(terminalState(terminal.terminal_id)).toBe('offline');
    await expect(client.openTerminal('shell', 'run-b')).rejects.toMatchObject({ code: 'conflict' });
    expect(driver.live.has('shell:run-b')).toBe(false);
  });

  it('rejects leases and input after a run ends while its provider pane remains alive', async () => {
    const client = new ControlClient(dir);
    const terminal = (await client.openTerminal('provider', 'run-a')).terminal;
    const lease = await client.acquireTerminal(terminal.terminal_id, 'writer');
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE runs SET state = 'done' WHERE run_id = 'run-a'").run());
    await expect(openStream(client, terminal.terminal_id).next(1)).rejects.toMatchObject({ code: 'conflict' });
    await expect(client.inputTerminal(terminal.terminal_id, lease.lease_id, 'x')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.acquireTerminal(terminal.terminal_id, 'next')).rejects.toMatchObject({ code: 'unavailable' });
    expect(driver.live.has('tmux:worker-a')).toBe(true);
    expect(driver.writes).toEqual([]);
  });

  it('does not let an old run lease the same agent pane after a new session starts', async () => {
    const client = new ControlClient(dir);
    const old = (await client.openTerminal('provider', 'run-a')).terminal;
    const lease = await client.acquireTerminal(old.terminal_id, 'old-writer');
    withEventDbTransaction(dir, (db) => {
      db.prepare("INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at) VALUES ('run-c', 'orch/c', 'worker-a', 'in_progress', '2026-01-02', '2026-01-02')").run();
      db.prepare("UPDATE sessions SET state = 'offline' WHERE session_id = 'session-a'").run();
      db.prepare("INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at) VALUES ('session-c', 'run-c', 'worker-a', 'claude', 'running', 'tmux', '2026-01-02', '2026-01-02')").run();
    });
    await expect(client.inputTerminal(old.terminal_id, lease.lease_id, 'x')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.acquireTerminal(old.terminal_id, 'next')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.openTerminal('provider', 'run-a')).rejects.toMatchObject({ code: 'conflict' });
    const current = (await client.openTerminal('provider', 'run-c')).terminal;
    expect(current.terminal_id).toBe('provider:session-c');
    const currentLease = await client.acquireTerminal(current.terminal_id, 'new-writer');
    await client.inputTerminal(current.terminal_id, currentLease.lease_id, 'y');
    expect(driver.writes).toEqual([{ handle: 'tmux:worker-a', data: 'y' }]);
  });

  it('retires a shell id when its run gets a new session so one handle has one writer', async () => {
    const client = new ControlClient(dir);
    const old = (await client.openTerminal('shell', 'run-b')).terminal;
    await client.acquireTerminal(old.terminal_id, 'old-writer');
    withEventDbTransaction(dir, (db) => {
      db.prepare("UPDATE sessions SET state = 'offline' WHERE session_id = 'session-b'").run();
      db.prepare("INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at) VALUES ('session-b2', 'run-b', 'worker-b', 'codex', 'running', 'app-server', '2026-01-02', '2026-01-02')").run();
    });
    const current = (await client.openTerminal('shell', 'run-b')).terminal;
    expect(current).toMatchObject({ terminal_id: 'shell:session-b2', handle: old.handle });
    await expect(client.acquireTerminal(old.terminal_id, 'second')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(openStream(client, old.terminal_id).next(1)).rejects.toMatchObject({ code: 'unavailable' });
    expect(terminalState(old.terminal_id)).toBe('offline');
    await expect(client.acquireTerminal(current.terminal_id, 'writer')).resolves.toHaveProperty('lease_id');
  });

  it('refuses a shell for a run that has no session yet', async () => {
    withEventDbTransaction(dir, (db) => db.prepare("DELETE FROM sessions WHERE session_id = 'session-b'").run());
    await expect(new ControlClient(dir).openTerminal('shell', 'run-b')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps an existing shell alive if persisting a reconnect fails', () => {
    const terminal = broker.shell('run-b');
    const failing = new TerminalBroker(dir, { driver, worktreeForRun: () => worktree });
    (failing as unknown as { save: () => never }).save = () => { throw new Error('database unavailable'); };
    expect(() => failing.shell('run-b')).toThrow('database unavailable');
    expect(driver.live.has(terminal.handle)).toBe(true);
  });

  it('shares one connection between two viewers, snapshot first, and stops it when both close', async () => {
    const client = new ControlClient(dir);
    const id = (await client.openTerminal('provider', 'run-a')).terminal.terminal_id;
    const first = openStream(client, id);
    await first.next(1);
    const second = openStream(client, id);
    await second.next(1);
    expect(driver.connections).toHaveLength(1);
    driver.connections[0].emit('hello');
    for (const view of [first, second]) {
      const frames = await view.next(2);
      expect(frames.map((frame) => frame.type)).toEqual(['snapshot', 'output']);
      expect(Buffer.from((frames[1] as { data: string }).data, 'base64').toString()).toBe('hello');
    }
    await first.close();
    await waitFor(() => broker['streams'].viewers('tmux:worker-a') === 1);
    expect(driver.connections[0].stopped).toBe(false);
    await second.close();
    await waitFor(() => driver.connections[0].stopped);
    const again = openStream(client, id);
    await again.next(1);
    expect(driver.connections).toHaveLength(2);
    await again.close();
  });

  it('ends every viewer with an exit frame when the agent exits', async () => {
    const client = new ControlClient(dir);
    const id = (await client.openTerminal('provider', 'run-a')).terminal.terminal_id;
    const view = openStream(client, id);
    await view.next(1);
    driver.connections[0].exit('session closed');
    expect((await view.next(2))[1]).toEqual({ type: 'exit', reason: 'session closed' });
    await view.done;
    expect(driver.connections[0].stopped).toBe(true);
  });

  it('sizes the pane for the lease holder or the first viewer only, and keeps two agents apart', async () => {
    withEventDbTransaction(dir, (db) => {
      db.prepare("INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at) VALUES ('run-c', 'orch/c', 'worker-c', 'in_progress', '2026-01-02', '2026-01-02')").run();
      db.prepare("INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at) VALUES ('session-c', 'run-c', 'worker-c', 'claude', 'running', 'tmux', '2026-01-02', '2026-01-02')").run();
    });
    driver.live.add('tmux:worker-c');
    const client = new ControlClient(dir);
    const a = (await client.openTerminal('provider', 'run-a')).terminal.terminal_id;
    const c = (await client.openTerminal('provider', 'run-c')).terminal.terminal_id;
    const firstA = openStream(client, a, { columns: 120, rows: 40 });
    await firstA.next(1);
    const firstC = openStream(client, c, { columns: 90, rows: 25 });
    await firstC.next(1);
    // A resize one column short and back makes the TUI redraw.
    expect(driver.sizes).toEqual([
      { handle: 'tmux:worker-a', columns: 119, rows: 40 }, { handle: 'tmux:worker-a', columns: 120, rows: 40 },
      { handle: 'tmux:worker-c', columns: 89, rows: 25 }, { handle: 'tmux:worker-c', columns: 90, rows: 25 },
    ]);
    expect(driver.connections.map((connection) => connection.handle)).toEqual(['tmux:worker-a', 'tmux:worker-c']);
    driver.connections[1].emit('only-c');
    expect((await firstC.next(2))[1]).toMatchObject({ type: 'output' });
    expect(firstA.frames).toHaveLength(1);

    driver.sizes = [];
    const secondA = openStream(client, a, { columns: 60, rows: 20 });
    await secondA.next(1);
    expect(driver.sizes).toEqual([]);
    const lease = await client.acquireTerminal(a, 'writer');
    await expect(client.resizeTerminal(a, 'not-the-lease', 70, 20)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(openStream(client, a, { leaseId: 'not-the-lease', columns: 70, rows: 20 }).next(1)).rejects.toMatchObject({ code: 'forbidden' });
    const writer = openStream(client, a, { leaseId: lease.lease_id, columns: 70, rows: 20 });
    await writer.next(1);
    expect(driver.sizes).toEqual([{ handle: 'tmux:worker-a', columns: 69, rows: 20 }, { handle: 'tmux:worker-a', columns: 70, rows: 20 }]);
    await expect(openStream(client, a, { columns: 10, rows: 20 }).next(1)).rejects.toMatchObject({ code: 'bad_request' });
    for (const view of [firstA, firstC, secondA, writer]) await view.close();
  });

  it('lists sessions with their terminals; an app session has none to stream', async () => {
    const client = new ControlClient(dir);
    expect((await client.sessions()).sessions).toEqual([
      { session_id: 'session-a', agent_id: 'worker-a', run_id: 'run-a', provider: 'claude', transport: 'tmux', terminal_id: 'provider:session-a' },
      { session_id: 'session-b', agent_id: 'worker-b', run_id: 'run-b', provider: 'codex', transport: 'app-server', terminal_id: null },
    ]);
    await expect(openStream(client, 'provider:session-b').next(1)).rejects.toMatchObject({ code: 'not_found' });
    await expect(openStream(client, 'provider:no-such-session').next(1)).rejects.toMatchObject({ code: 'not_found' });
    // A provider id from the list opens without a prior POST /v1/terminals/provider.
    const view = openStream(client, 'provider:session-a');
    expect((await view.next(1))[0]).toMatchObject({ type: 'snapshot' });
    await view.close();
    driver.live.delete('tmux:worker-a');
    expect((await client.sessions()).sessions[0].terminal_id).toBeNull();
  });

  it('refuses operator input with a retryable busy while the coordinator sends', async () => {
    const client = new ControlClient(dir);
    const id = (await client.openTerminal('provider', 'run-a')).terminal.terminal_id;
    const lease = await client.acquireTerminal(id, 'operator');
    withEventDbTransaction(dir, (db) => db.prepare(`INSERT INTO control_leases (resource_type, resource_id, lease_id, owner_id, expires_at)
      VALUES ('terminal_send', ?, 'send-1', 'coordinator:1', '2099-01-01')`).run(id));
    await expect(client.inputTerminal(id, lease.lease_id, 'x')).rejects.toMatchObject({ code: 'busy' });
    withEventDbTransaction(dir, (db) => db.prepare("DELETE FROM control_leases WHERE resource_type = 'terminal_send'").run());
    await client.inputTerminal(id, lease.lease_id, 'x');
    expect(driver.writes).toEqual([{ handle: 'tmux:worker-a', data: 'x' }]);
  });
});

describe.runIf(process.env.RUN_TMUX_SMOKE === '1')('real tmux terminal smoke', () => {
  it('keeps a shell attached across driver instances, resizes it, and stops only that shell', async () => {
    const real = new TmuxTerminalDriver(dir);
    const handle = 'shell:smoke-run';
    const logPath = join(dir, 'tmux-smoke.log');
    real.startShell(handle, worktree, logPath);
    try {
      expect(real.alive(handle)).toBe(true);
      real.resize(handle, 110, 32);
      real.input(handle, 'pwd\r');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(new TmuxTerminalDriver(dir).snapshot(handle).screen).toContain(worktree);
    } finally {
      real.stop(handle);
    }
    expect(real.alive(handle)).toBe(false);
  });
});
