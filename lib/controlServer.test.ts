import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { appendSequencedEvent, closeAllDatabases, initEventsDb, withEventDb, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { CommandDispatcher, markSendStarted, markSent, reserveCommand } from './commandDelivery.ts';
import { ControlClient, type EventRow } from './controlClient.ts';
import { CONTROL_ENDPOINT_FILE, CONTROL_TOKEN_FILE, ControlError, defaultSocketPath } from './controlProtocol.ts';
import { sessionAuthenticator, startControlServer, type ControlServer } from './controlServer.ts';
import { closeProjectTaskStores, initProjectTaskStore } from './projectTasks.ts';
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
  closeProjectTaskStores();
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

function rawGet(headers: Record<string, string>, path = '/v1/snapshot'): Promise<{ status: number; body: { ok: boolean; error?: { code: string } } }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: server.endpoint.path, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function heartbeats(count: number): void {
  for (let i = 0; i < count; i += 1) {
    appendSequencedEvent(dir, {
      ts: new Date().toISOString(), event: 'heartbeat', actor_type: 'agent', actor_id: 'worker-a',
      run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', payload: {},
    });
  }
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
  it('creates and revises project tasks with revision checks and master-only authoring', async () => {
    const master = new ControlClient(dir, { sessionToken: 'session-master' });
    await expect(master.listTasks()).rejects.toMatchObject({ code: 'not_found' });
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [
      { agent_id: 'master', provider: 'codex', role: 'master', capabilities: [], status: 'idle', registered_at: '2026-01-01T00:00:00.000Z' },
      { agent_id: 'worker-a', provider: 'claude', role: 'worker', capabilities: [], status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
    ] }));
    initProjectTaskStore(dir);
    const { task } = await master.createTask({ feature: 'app', title: 'Remote task', body_markdown: '# Remote task\n\nDo it.\n' });
    expect(task).toMatchObject({ ref: 'app/remote-task', spec_revision: 1, body_markdown: '# Remote task\n\nDo it.\n' });
    expect((await master.getTask('app/remote-task')).task).toMatchObject({ spec_revision: 1 });
    expect(await master.reviseTask('app/remote-task', 1, { priority: 'high' })).toMatchObject({ changed: true, task: { spec_revision: 2, priority: 'high' } });
    await expect(master.reviseTask('app/remote-task', 1, { priority: 'low' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(master.getTask('app/missing')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(master.createTask({ feature: 'app', title: 'Remote task' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(master.createTask({ feature: 'app', title: 'Bad', priority: 'urgent' })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(new ControlClient(dir, { sessionToken: 'session-a' }).createTask({ feature: 'app', title: 'Worker task' }))
      .rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect((await master.listTasks()).tasks.map((entry) => entry.ref)).toEqual(['app/remote-task']);
  });

  it('routes a cross-provider review and result durably through session mailboxes', async () => {
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE sessions SET provider = 'codex' WHERE session_id = 'session-b'").run());
    const sent: Array<{ kind: string; payload: string; recipient_id: string }> = [];
    const dispatcher = new CommandDispatcher(dir, { send: (command) => { sent.push(command); return Promise.resolve(); } }, sessionAuthenticator(dir));
    await server.close();
    server = await startControlServer(dir, { pollMs: 20, commands: dispatcher });
    const a = new ControlClient(dir, { sessionToken: 'session-a' });
    const b = new ControlClient(dir, { sessionToken: 'session-b' });
    const input = { runId: 'run-a', recipientSessionId: 'session-b', idempotencyKey: 'review-1',
      kind: 'review_request' as const, text: 'Review this change', artifactRefs: ['git:abc123'] };
    const first = (await a.sendMessage(input)).message;
    expect((await a.sendMessage(input)).message.message_id).toBe(first.message_id);
    expect(first.command_id).toBeTruthy();
    await dispatcher.tick();
    expect(sent.some((command) => command.kind === 'semantic_message'
      && command.recipient_id === 'worker-b'
      && JSON.parse(command.payload).message_id === first.message_id
      && !command.payload.includes('Review this change'))).toBe(true);
    expect(JSON.parse(first.payload)).toEqual({ text: 'Review this change', artifact_refs: ['git:abc123'] });
    expect((await b.messages()).messages.map((m) => m.message_id)).toContain(first.message_id);
    expect((await b.consumeMessage(first.message_id)).message.state).toBe('consumed');
    expect((await b.consumeMessage(first.message_id)).message.consumed_at).toBeTruthy();
    const result = (await b.sendMessage({ runId: 'run-b', recipientSessionId: 'session-a', idempotencyKey: 'result-1',
      kind: 'result', text: 'approved', parentMessageId: first.message_id })).message;
    expect(result.parent_message_id).toBe(first.message_id);
    expect((await a.messages()).messages.map((m) => m.message_id)).toContain(result.message_id);
    await server.close();
    server = await startControlServer(dir, { pollMs: 20 });
    expect((await a.messages()).messages.map((m) => m.message_id)).toContain(result.message_id);
    expect((await a.consumeMessage(result.message_id)).message.state).toBe('consumed');
    expect((await a.messages()).messages).toEqual([]);
  });

  it('rejects unscoped actors, stale recipients, forged replies and privileged command kinds', async () => {
    const a = new ControlClient(dir, { sessionToken: 'session-a' });
    const b = new ControlClient(dir, { sessionToken: 'session-b' });
    const input = { runId: 'run-a', recipientSessionId: 'session-b', idempotencyKey: 'review-2',
      kind: 'review_request' as const, text: 'orc task-reset all', artifactRefs: ['git:def456'] };
    const message = (await a.sendMessage(input)).message;
    expect(await a.messages()).toEqual({ messages: [] });
    await expect(b.consumeMessage(message.message_id.replace('msg-', 'missing-'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.consumeMessage(message.message_id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(b.sendMessage({ ...input, idempotencyKey: 'wrong-run', runId: 'run-a', recipientSessionId: 'session-a' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(a.sendMessage({ ...input, idempotencyKey: 'bad-kind', kind: 'task_reset' as 'message' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(a.sendMessage({ ...input, idempotencyKey: 'bad-reply', parentMessageId: message.message_id }))
      .rejects.toMatchObject({ code: 'forbidden' });
    const ordinary = (await a.sendMessage({ runId: 'run-a', recipientSessionId: 'session-b', idempotencyKey: 'ordinary',
      kind: 'message', text: 'Hello' })).message;
    await expect(b.sendMessage({ runId: 'run-b', recipientSessionId: 'session-a', idempotencyKey: 'fake-review-result',
      kind: 'result', text: 'approved', parentMessageId: ordinary.message_id })).rejects.toMatchObject({ code: 'bad_request' });
    withEventDbTransaction(dir, (db) => db.prepare("UPDATE sessions SET state = 'offline' WHERE session_id = 'session-b'").run());
    await expect(a.sendMessage({ ...input, idempotencyKey: 'stale' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(withEventDb(dir, (db) => (db.prepare("SELECT COUNT(*) AS n FROM commands WHERE kind = 'task_reset'").get() as { n: number }).n)).toBe(0);
  });

  it('retries the same review message across sender and recipient reconnects', async () => {
    const input = { runId: 'run-a', recipientSessionId: 'session-b', idempotencyKey: 'reconnect-review',
      kind: 'review_request' as const, text: 'Review', artifactRefs: ['git:abc'] };
    const first = (await new ControlClient(dir, { sessionToken: 'session-a' }).sendMessage(input)).message;
    withEventDbTransaction(dir, (db) => {
      db.prepare("UPDATE sessions SET state = 'offline' WHERE session_id IN ('session-a', 'session-b')").run();
      db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
        VALUES ('session-a-new', 'run-a', 'worker-a', 'claude', 'running', 'later', 'later'),
          ('session-b-new', 'run-b', 'worker-b', 'codex', 'running', 'later', 'later')`).run();
    });
    const retried = (await new ControlClient(dir, { sessionToken: 'session-a-new' }).sendMessage({ ...input, recipientSessionId: 'session-b-new' })).message;
    expect(retried.message_id).toBe(first.message_id);
    expect(retried.recipient_session_id).toBe('session-b-new');
    expect(retried.command_id).not.toBe(first.command_id);
    expect((await new ControlClient(dir, { sessionToken: 'session-b-new' }).messages()).messages.map((m) => m.message_id)).toContain(first.message_id);
  });

  it('publishes an owner-only endpoint and rejects unversioned or unauthenticated requests', async () => {
    expect(statSync(server.endpoint.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, CONTROL_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    const token = readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8');

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

  it('pages events with a bounded limit and validates cursors', async () => {
    const client = new ControlClient(dir);
    const { cursor } = await client.snapshot();
    heartbeats(5);
    const first = await client.events(cursor, 3);
    expect(first.events.map((row) => row.seq)).toEqual([cursor + 1, cursor + 2, cursor + 3]);
    expect(first.cursor).toBe(cursor + 3);
    const rest = await client.events(first.cursor, 100);
    expect(rest.events).toHaveLength(2);
    expect((await client.events(rest.cursor)).cursor).toBe(rest.cursor);
    await expect(client.events(0, 1001)).rejects.toMatchObject({ code: 'bad_request' });
    const token = readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8');
    const negative = await rawGet({ 'x-orc-protocol': '1', authorization: `Bearer ${token}` }, '/v1/events?after=-1');
    expect(negative.body.error?.code).toBe('bad_request');
  });

  it('streams more than one read batch in order and sends heartbeats', async () => {
    await server.close();
    server = await startControlServer(dir, { pollMs: 20, heartbeatMs: 20 });
    const client = new ControlClient(dir);
    const { cursor } = await client.snapshot();
    heartbeats(650);
    const rows = await take(client.subscribe(cursor), 650);
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 650 }, (_, i) => cursor + i + 1));

    const token = readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8');
    const frames = await new Promise<string[]>((resolve, reject) => {
      const req = request({ socketPath: server.endpoint.path, path: `/v1/events/stream?after=${cursor + 650}`, headers: { 'x-orc-protocol': '1', authorization: `Bearer ${token}` } }, (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
          const lines = text.split('\n').filter(Boolean);
          if (lines.length >= 2) { req.destroy(); resolve(lines); }
        });
      });
      req.on('error', (error) => { if (!req.destroyed) reject(error); });
      req.end();
    });
    expect(frames.map((line) => JSON.parse(line) as { type: string; cursor: number })).toEqual([
      { type: 'heartbeat', cursor: cursor + 650 }, { type: 'heartbeat', cursor: cursor + 650 },
    ]);
  });

  it('rejects derived legacy credentials and maps unknown commands to not_found', async () => {
    withEventDbTransaction(dir, (db) => {
      db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
        VALUES ('legacy-0123456789abcdef01234567', NULL, 'auditor', 'codex', 'running', '2026-01-01', '2026-01-01')`).run();
    });
    await expect(submit(new ControlClient(dir, { sessionToken: 'legacy-0123456789abcdef01234567' }), 'l1'))
      .rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(new ControlClient(dir, { sessionToken: 'session-a' }).acknowledge('cmd-missing', 'accepted'))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    const snapshot = await new ControlClient(dir).snapshot();
    expect(snapshot.sessions.find((row) => row.agent_id === 'worker-a')).toEqual({ session_id: 'session-a', agent_id: 'worker-a', run_id: 'run-a', state: 'running', transport: null, state_reason: null });
  });

  it('reports a crashed daemon with a stale descriptor as not running', async () => {
    const descriptor = readFileSync(join(dir, CONTROL_ENDPOINT_FILE), 'utf8');
    const token = readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8');
    await server.close();
    writeFileSync(join(dir, CONTROL_ENDPOINT_FILE), descriptor);
    writeFileSync(join(dir, CONTROL_TOKEN_FILE), token);
    await expect(new ControlClient(dir).snapshot()).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('stale endpoint') });
    const iterator = new ControlClient(dir).subscribe(0);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'unavailable' });
    server = await startControlServer(dir, { pollMs: 20 });
  });

  it('falls back to a private per-user directory for long state paths', () => {
    const path = defaultSocketPath(join(dir, 'x'.repeat(120)));
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(104);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect(defaultSocketPath(join(dir, 'x'.repeat(120)))).toBe(path);
  });
});
