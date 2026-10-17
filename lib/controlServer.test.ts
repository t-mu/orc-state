import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDb, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { markSendStarted, markSent, reserveCommand } from './commandDelivery.ts';
import { ControlClient, type EventRow } from './controlClient.ts';
import { CONTROL_ENDPOINT_FILE, CONTROL_TOKEN_FILE, ControlError } from './controlProtocol.ts';
import { startControlServer, type ControlServer } from './controlServer.ts';
import type { Claim } from '../types/claims.ts';

const exec = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..');
let dir: string;
let server: ControlServer;

function claim(runId: string, agentId: string, taskRef: string): Claim {
  return {
    run_id: runId, task_ref: taskRef, agent_id: agentId, state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
  };
}

beforeEach(async () => {
  dir = createTempStateDir('orch-control-');
  seedState(dir);
  initEventsDb(dir);
  commitClaims(dir, { version: '1', claims: [claim('run-a', 'worker-a', 'orch/task-a'), claim('run-b', 'worker-b', 'orch/task-b')] });
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
      VALUES ('session-master', NULL, 'master', 'codex', 'running', '2026-01-01', '2026-01-01'),
        ('session-a', 'run-a', 'worker-a', 'claude', 'running', '2026-01-01', '2026-01-01'),
        ('session-b', 'run-b', 'worker-b', 'claude', 'running', '2026-01-01', '2026-01-01')`).run();
  });
  server = await startControlServer(dir, { pollMs: 20 });
});

afterEach(async () => {
  await server.close();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

function cli(...args: string[]) {
  return exec(process.execPath, args, {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...process.env, ORC_STATE_DIR: dir, ORC_REPO_ROOT: dir, ORC_SESSION_TOKEN: '' },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  );
}

function rawGet(headers: Record<string, string>): Promise<{ status: number; body: { ok: boolean; error?: { code: string } } }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: server.endpoint.path, path: '/v1/snapshot', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function commandCount(): number {
  return withEventDb(dir, (db) => (db.prepare('SELECT COUNT(*) AS n FROM commands').get() as { n: number }).n);
}

async function take(stream: AsyncGenerator<EventRow>, count: number): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for await (const row of stream) {
    rows.push(row);
    if (rows.length >= count) break;
  }
  return rows;
}

const submit = (client: ControlClient, key: string, run = 'run-a', recipient = 'session-a') => client.submitCommand({
  run_id: run, recipient_session_id: recipient, idempotency_key: key, kind: 'input', payload: { text: key },
});

describe('local daemon control API', () => {
  it('publishes an owner-only endpoint and rejects unversioned or unauthenticated requests', async () => {
    expect(statSync(server.endpoint.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, CONTROL_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    const token = (await import('node:fs')).readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8');

    const noVersion = await rawGet({ authorization: `Bearer ${token}` });
    expect(noVersion.status).toBe(400);
    expect(noVersion.body.error?.code).toBe('unsupported_protocol_version');
    const future = await rawGet({ authorization: `Bearer ${token}`, 'x-orc-protocol': '2' });
    expect(future.body.error?.code).toBe('unsupported_protocol_version');
    for (const authorization of [undefined, 'Bearer wrong', token]) {
      const result = await rawGet({ 'x-orc-protocol': '1', ...(authorization ? { authorization } : {}) });
      expect(result.status).toBe(401);
      expect(result.body.error?.code).toBe('unauthenticated');
    }
    expect((await rawGet({ 'x-orc-protocol': '1', authorization: `Bearer ${token}` })).body.ok).toBe(true);
  });

  it('lets separate client processes read a snapshot, follow events and submit an allowed command', async () => {
    const snapshot = JSON.parse((await cli('cli/control.ts', 'snapshot')).stdout) as { cursor: number; runs: Array<{ run_id: string }> };
    expect(snapshot.runs.map((run) => run.run_id).sort()).toEqual(['run-a', 'run-b']);

    const follower = cli('cli/control.ts', 'events', '--follow', `--after=${snapshot.cursor}`, '--max-events=1');
    const submitted = await cli('cli/control.ts', 'command', '--session-token=session-master', '--run-id=run-a',
      '--recipient-session=session-a', '--kind=input', '--idempotency-key=k1', '--payload={"text":"hi"}');
    expect(submitted.code).toBe(0);
    const command = JSON.parse(submitted.stdout) as { command_id: string; state: string; actor_id: string };
    expect(command).toMatchObject({ state: 'queued', actor_id: 'master' });

    const followed = await follower;
    expect(followed.code).toBe(0);
    const row = JSON.parse(followed.stdout.trim()) as { seq: number; event: { event: string; payload: { command_id: string } } };
    expect(row.seq).toBeGreaterThan(snapshot.cursor);
    expect(row.event.event).toBe('command_queued');
    expect(row.event.payload.command_id).toBe(command.command_id);

    // Delivery is not wired to a provider transport yet; simulate the send.
    expect((await cli('cli/control.ts', 'ack', command.command_id, '--state=accepted', '--session-token=session-a')).stderr).toContain('Cannot acknowledge queued');
    reserveCommand(dir);
    markSendStarted(dir, command.command_id);
    markSent(dir, command.command_id);
    const acked = await cli('cli/control.ts', 'ack', command.command_id, '--state=accepted', '--session-token=session-a');
    expect(JSON.parse(acked.stdout).state).toBe('accepted');
  });

  it('rejects unauthenticated and cross-run mutations without writing commands', async () => {
    const args = ['cli/control.ts', 'command', '--run-id=run-a', '--recipient-session=session-a', '--kind=input', '--idempotency-key=k1'];
    const anonymous = await cli(...args);
    expect(anonymous.code).toBe(1);
    expect(anonymous.stderr).toContain('Session credential required');
    expect((await cli(...args, '--session-token=forged')).stderr).toContain('not authenticated');

    const crossActor = new ControlClient(dir, { sessionToken: 'session-b' });
    await expect(submit(crossActor, 'k2')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const crossRecipient = new ControlClient(dir, { sessionToken: 'session-a' });
    await expect(submit(crossRecipient, 'k3', 'run-a', 'session-b')).rejects.toMatchObject({ code: 'forbidden' });
    expect(commandCount()).toBe(0);

    const { command } = await submit(new ControlClient(dir, { sessionToken: 'session-master' }), 'k4');
    reserveCommand(dir);
    markSendStarted(dir, command.command_id);
    await expect(crossActor.acknowledge(command.command_id, 'accepted')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(new ControlClient(dir).acknowledge(command.command_id, 'accepted')).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('resumes after the snapshot cursor across a disconnect and a daemon restart without gaps', async () => {
    const master = new ControlClient(dir, { sessionToken: 'session-master' });
    const { cursor } = await master.snapshot();
    const seen: EventRow[] = [];

    const first = master.subscribe(cursor);
    const firstBatch = take(first, 2);
    await submit(master, 'r1');
    await submit(master, 'r2');
    seen.push(...await firstBatch);

    // Events written while no subscriber is connected, then a new daemon token.
    await submit(master, 'r3');
    await server.close();
    server = await startControlServer(dir, { pollMs: 20 });
    await submit(master, 'r4');

    seen.push(...await take(master.subscribe(seen.at(-1)!.seq), 2));
    const expected = withEventDb(dir, (db) => (db.prepare('SELECT seq FROM events WHERE seq > ? ORDER BY seq').all(cursor) as Array<{ seq: number }>).map((r) => r.seq));
    expect(seen.map((row) => row.seq)).toEqual(expected);
    expect(seen.map((row) => (row.event as { event: string }).event)).toEqual(Array(4).fill('command_queued'));
  });

  it('serves runs-active through the control API with the same rows as the legacy path', async () => {
    const legacy = JSON.parse((await cli('cli/runs-active.ts', '--json')).stdout) as { runs: Array<Record<string, unknown>> };
    const viaControl = JSON.parse((await cli('cli/runs-active.ts', '--json', '--via-control')).stdout) as { runs: Array<Record<string, unknown>> };
    const stable = (runs: Array<Record<string, unknown>>) => runs.map(({ age_seconds: _a, idle_seconds: _i, ...rest }) => rest);
    expect(viaControl.runs).toHaveLength(2);
    expect(stable(viaControl.runs)).toEqual(stable(legacy.runs));
  });

  it('refuses a second daemon on a live socket and removes its endpoint on close', async () => {
    await expect(startControlServer(dir, { socketPath: server.endpoint.path })).rejects.toThrow('already in use');
    await server.close();
    expect(existsSync(join(dir, CONTROL_ENDPOINT_FILE))).toBe(false);
    await expect(new ControlClient(dir).snapshot()).rejects.toBeInstanceOf(ControlError);
    const legacy = await cli('cli/runs-active.ts', '--json');
    expect(JSON.parse(legacy.stdout).total).toBe(2);
    expect((await cli('cli/runs-active.ts', '--via-control')).stderr).toContain('not running');
    server = await startControlServer(dir, { pollMs: 20 });
  });
});
