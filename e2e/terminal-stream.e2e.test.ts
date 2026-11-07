import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { killTmuxServer, tmuxSocketName } from '../adapters/tmux.ts';
import { ControlClient } from '../lib/controlClient.ts';
import type { TerminalFrame } from '../lib/controlProtocol.ts';
import { startControlServer, type ControlServer } from '../lib/controlServer.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from '../lib/eventLog.ts';
import { commitClaims } from '../lib/runStore.ts';
import { TerminalBroker, TmuxTerminalDriver } from '../lib/terminalBroker.ts';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

let dir: string;
let server: ControlServer;

/** Collects a stream's frames; the decoded output text is kept alongside. */
function watch(client: ControlClient, terminalId: string, options: { leaseId?: string; columns?: number; rows?: number } = {}) {
  const abort = new AbortController();
  const frames: TerminalFrame[] = [];
  let output = Buffer.alloc(0);
  const done = (async () => {
    for await (const frame of client.streamTerminal(terminalId, options, abort.signal)) {
      frames.push(frame);
      if (frame.type === 'output') output = Buffer.concat([output, Buffer.from(frame.data, 'base64')]);
    }
  })();
  return { frames, text: () => output.toString('utf8'), done, close: async () => { abort.abort(); await done; } };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function controlClients(): number {
  const result = spawnSync('tmux', ['-L', tmuxSocketName(dir), 'list-clients', '-F', '#{client_control_mode}'], { encoding: 'utf8' });
  return result.stdout.split('\n').filter((line) => line === '1').length;
}

describe.skipIf(!hasTmux)('terminal stream over tmux control mode', () => {
  beforeEach(async () => {
    dir = createTempStateDir('orch-terminal-stream-');
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), 'gitdir: dummy');
    seedState(dir);
    initEventsDb(dir);
    commitClaims(dir, { version: '1', claims: [
      { run_id: 'run-a', task_ref: 'orch/a', agent_id: 'worker-a', state: 'in_progress', claimed_at: '2026-01-01', started_at: '2026-01-01', lease_expires_at: '2099-01-01' },
    ] });
    withEventDbTransaction(dir, (db) => db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, started_at, updated_at)
      VALUES ('session-a', 'run-a', 'worker-a', 'codex', 'running', 'app-server', '2026-01-01', '2026-01-01')`).run());
    const broker = new TerminalBroker(dir, { driver: new TmuxTerminalDriver(dir), worktreeForRun: () => worktree, livenessMs: 200 });
    server = await startControlServer(dir, { terminals: broker });
  });

  afterEach(async () => {
    await server.close();
    killTmuxServer(dir);
    closeAllDatabases();
    cleanupTempStateDir(dir);
  });

  it('streams a real session: snapshot, live output, sizing, one shared client, and exit', async () => {
    const client = new ControlClient(dir);
    const terminal = (await client.openTerminal('shell', 'run-a')).terminal;
    const lease = await client.acquireTerminal(terminal.terminal_id, 'e2e');
    const writer = watch(client, terminal.terminal_id, { leaseId: lease.lease_id, columns: 90, rows: 25 });
    await waitFor(() => writer.frames.length > 0);
    expect(writer.frames[0]).toMatchObject({ type: 'snapshot' });
    await waitFor(() => new TmuxTerminalDriver(dir).snapshot(terminal.handle).columns === 90);
    expect(new TmuxTerminalDriver(dir).snapshot(terminal.handle)).toMatchObject({ columns: 90, rows: 25 });

    const viewer = watch(client, terminal.terminal_id, { columns: 60, rows: 20 });
    await waitFor(() => viewer.frames.length > 0);
    expect(controlClients()).toBe(1);
    expect(new TmuxTerminalDriver(dir).snapshot(terminal.handle)).toMatchObject({ columns: 90, rows: 25 });

    await client.inputTerminal(terminal.terminal_id, lease.lease_id, 'echo STREAM_$((40+2))\r');
    await waitFor(() => writer.text().includes('STREAM_42') && viewer.text().includes('STREAM_42'));
    expect(viewer.frames.findIndex((frame) => frame.type === 'output')).toBeGreaterThan(0);

    await viewer.close();
    await waitFor(() => controlClients() === 1);
    await client.inputTerminal(terminal.terminal_id, lease.lease_id, 'exit\r');
    await writer.done;
    expect(writer.frames.at(-1)).toMatchObject({ type: 'exit' });
    await waitFor(() => controlClients() === 0);
  }, 20_000);
});
