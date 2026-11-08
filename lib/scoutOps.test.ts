import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDbTransaction } from './eventLog.ts';
import { ControlClient } from './controlClient.ts';
import { CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE, OPERATOR_HEADER, OPERATOR_TOKEN_FILE, PROTOCOL_HEADER } from './controlProtocol.ts';
import { startControlServer, type ControlServer } from './controlServer.ts';
import { closeProjectTaskStores, initProjectTaskStore } from './projectTasks.ts';
import { commitClaims } from './runStore.ts';
import { credentialHash } from './sessionCredentials.ts';
import { getAgent, updateAgentRuntime } from './agentRegistry.ts';
import { TARGET_REPO_ROOT } from './paths.ts';

const { sendMock, stopMock, probeMock, tailMock, launchMock } = vi.hoisted(() => ({
  sendMock: vi.fn(), stopMock: vi.fn(), probeMock: vi.fn(), tailMock: vi.fn(), launchMock: vi.fn(),
}));

vi.mock('../adapters/index.ts', () => ({
  createAdapter: vi.fn(() => ({ start: vi.fn(), send: sendMock, attach: vi.fn(), heartbeatProbe: probeMock, stop: stopMock, getOutputTail: tailMock })),
}));
vi.mock('./workerRuntime.ts', () => ({ launchWorkerSession: launchMock }));

let dir: string;
let server: ControlServer;

/** A launch that succeeds once `release` is called, with the session-start hook's readiness fields set. */
function slowLaunch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  launchMock.mockImplementation(async (stateDir, agent) => {
    await gate;
    // The real launch records the session on the agent; the hook then marks it ready.
    const session = { status: 'running', session_handle: `tmux:${agent.agent_id}`, session_token: 'token-1',
      session_started_at: '2026-01-01T00:00:00.000Z', session_ready_at: '2026-01-01T00:00:01.000Z' } as const;
    Object.assign(agent, session);
    updateAgentRuntime(stateDir, agent.agent_id, session);
    return { ok: true, session_handle: `tmux:${agent.agent_id}` };
  });
  return release;
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).toBe(true);
};
const scoutEvents = (type: 'scout_launched' | 'scout_launch_failed') => queryEvents(dir, { event_type: type });

function rawPost(path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request({ socketPath: server.endpoint.path, path, method: 'POST', headers: {
      authorization: `Bearer ${readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8').trim()}`, [PROTOCOL_HEADER]: String(CONTROL_PROTOCOL_VERSION),
      [OPERATOR_HEADER]: readFileSync(join(dir, OPERATOR_TOKEN_FILE), 'utf8').trim(),
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.ORC_SCOUT_READY_TIMEOUT_MS = '50';
  dir = createTempStateDir('orc-scout-ops-');
  seedState(dir);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [
    { agent_id: 'master', provider: 'claude', role: 'master', capabilities: [], status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
    { agent_id: 'worker-a', provider: 'claude', role: 'worker', capabilities: [], status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
  ] }));
  initEventsDb(dir);
  initProjectTaskStore(dir);
  commitClaims(dir, { version: '1', claims: [{ run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z' }] });
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at, credential_hash)
      VALUES ('session-master', NULL, 'master', 'claude', 'running', '2026-01-01', '2026-01-01', ?),
        ('session-a', 'run-a', 'worker-a', 'claude', 'running', '2026-01-01', '2026-01-01', ?)`)
      .run(credentialHash('secret-master'), credentialHash('secret-a'));
  });
  server = await startControlServer(dir, { pollMs: 20 });
});

afterEach(async () => {
  delete process.env.ORC_SCOUT_READY_TIMEOUT_MS;
  await server.close();
  closeProjectTaskStores();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('scouts over the control API', () => {
  it('answers request-scout with the scout id at once, then launches, briefs and reports it as scout_launched', async () => {
    const release = slowLaunch();
    const response = await rawPost('/v1/operator', { op: 'request-scout', objective: 'Why is run-a stalled?' });
    expect(response.status).toBe(202);
    expect(JSON.parse(response.text).result).toEqual({ agent_id: 'scout-1' });
    // Registered and returned while the launch is still pending.
    expect(getAgent(dir, 'scout-1')).toMatchObject({ role: 'scout' });
    expect(scoutEvents('scout_launched')).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();

    release();
    await until(() => scoutEvents('scout_launched').length === 1);
    // Briefed from the hook-set readiness, without the scout running report-for-duty.
    expect(sendMock).toHaveBeenCalledWith('tmux:scout-1', expect.stringContaining('Why is run-a stalled?'));
    expect(launchMock).toHaveBeenCalledWith(dir, expect.objectContaining({ agent_id: 'scout-1' }), expect.objectContaining({ workingDirectory: TARGET_REPO_ROOT }));
    expect(scoutEvents('scout_launched')[0]).toMatchObject({ agent_id: 'scout-1', payload: { requested_by: 'human', session_handle: 'tmux:scout-1' } });
  });

  it('reads a scout\'s report and removes the scout over the API', async () => {
    slowLaunch()();
    const operatorClient = new ControlClient(dir);
    const { agent_id: scoutId } = await operatorClient.operator({ op: 'request-scout', objective: 'look' });
    await until(() => scoutEvents('scout_launched').length === 1);

    tailMock.mockReturnValue('working...');
    probeMock.mockResolvedValue(true);
    expect(await operatorClient.scoutReport(scoutId)).toMatchObject({ agent_id: scoutId, status: 'running', report: null });
    const report = ['SCOUT_REPORT', 'findings: a', 'likely_cause: b', 'recommended_action: c', 'SCOUT_REPORT_END'].join('\n');
    tailMock.mockReturnValue(report);
    expect(await operatorClient.scoutReport(scoutId)).toMatchObject({ status: 'reported', report: 'findings: a\nlikely_cause: b\nrecommended_action: c' });

    expect(await operatorClient.operator({ op: 'remove-scout', agent_id: scoutId })).toEqual({ agent_id: scoutId, removed: true });
    expect(stopMock).toHaveBeenCalledWith(`tmux:${scoutId}`);
    expect(getAgent(dir, scoutId)).toBeFalsy();
    expect(await operatorClient.operator({ op: 'remove-scout', agent_id: scoutId })).toEqual({ agent_id: scoutId, removed: false, reason: 'not_found' });
    await expect(operatorClient.scoutReport(scoutId)).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('records scout_launch_failed with the reason and removes the scout when the launch fails', async () => {
    launchMock.mockResolvedValue({ ok: false, reason: 'tmux server is gone' });
    const { agent_id: scoutId } = await new ControlClient(dir, { credential: 'secret-master' }).operator({ op: 'request-scout', objective: 'look' });
    await until(() => scoutEvents('scout_launch_failed').length === 1);
    expect(scoutEvents('scout_launch_failed')[0]).toMatchObject({
      agent_id: scoutId, payload: { requested_by: 'master', provider: 'claude', reason: 'Failed to launch scout scout-1: tmux server is gone' },
    });
    expect(getAgent(dir, scoutId)).toBeFalsy();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails a launch whose session never becomes ready, with the failure hint for a sandboxed scout', async () => {
    launchMock.mockImplementation((_stateDir, agent) => {
      agent.session_handle = `tmux:${agent.agent_id}`;
      agent.session_token = 'token-1';
      return Promise.resolve({ ok: true, session_handle: `tmux:${agent.agent_id}` });
    });
    await new ControlClient(dir, { credential: 'secret-master' }).operator({ op: 'request-scout', objective: 'look' });
    await until(() => scoutEvents('scout_launch_failed').length === 1);
    expect(scoutEvents('scout_launch_failed')[0]).toMatchObject({ payload: { reason: expect.stringContaining('did not become ready in time') } });
    expect(stopMock).toHaveBeenCalledWith('tmux:scout-1');
    expect(getAgent(dir, 'scout-1')).toBeFalsy();
  });

  it('validates a request before registering anything', async () => {
    const operatorClient = new ControlClient(dir);
    await expect(operatorClient.operator({ op: 'request-scout', objective: '  ' })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(operatorClient.operator({ op: 'request-scout', objective: 'x', provider: 'nope' })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(operatorClient.operator({ op: 'request-scout', objective: 'x', scope_paths: [1] })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(launchMock).not.toHaveBeenCalled();
    expect(getAgent(dir, 'scout-1')).toBeFalsy();
  });

  it('refuses a worker session on every scout route and refuses removing a non-scout', async () => {
    const worker = new ControlClient(dir, { credential: 'secret-a' });
    await expect(worker.operator({ op: 'request-scout', objective: 'look' })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(worker.operator({ op: 'remove-scout', agent_id: 'scout-1' })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(worker.scoutReport('scout-1')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(launchMock).not.toHaveBeenCalled();
    await expect(new ControlClient(dir).operator({ op: 'remove-scout', agent_id: 'worker-a' })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(getAgent(dir, 'worker-a')).not.toBeNull();
  });
});

const plan = (id: number, name: string) => [
  '---', `plan_id: ${id}`, `name: ${name}`, `title: Plan ${name}`,
  'created_at: 2026-10-24T19:49:28Z', 'updated_at: 2026-10-24T19:49:28Z', 'derived_task_refs: []', '---', '',
  `# Plan ${name}`, '', '## Objective', '', 'Do it.', '', '## Scope', '', '- Things.', '', '## Out of Scope', '', '- Others.', '',
  '## Constraints', '', '- None.', '', '## Affected Areas', '', '- `lib/x.ts`.', '',
  '## Implementation Steps', '', '### Step 1 — Do', '', 'Work.', '',
].join('\n');

describe('POST /v1/plans/import', () => {
  it('stores the plans the client sends, all or none', async () => {
    const operatorClient = new ControlClient(dir);
    const good = { path: '/client/5-alpha.md', text: plan(5, 'alpha') };
    expect(await operatorClient.importPlans([good])).toEqual({ imported: [{ path: '/client/5-alpha.md', plan_id: 5, changed: true }] });
    expect(await operatorClient.importPlans([good])).toMatchObject({ imported: [{ plan_id: 5, changed: false }] });
    const store = initProjectTaskStore(dir);
    expect(store.getPlan(5)).toMatchObject({ name: 'alpha', bodyMarkdown: good.text, sourcePath: '/client/5-alpha.md' });

    await expect(operatorClient.importPlans([{ path: '/client/6-beta.md', text: plan(6, 'beta') }, { path: '/client/bad.md', text: '---\nplan_id: 7\n---\n# nope\n' }]))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(store.getPlan(6)).toBeNull();
    await expect(operatorClient.importPlans([good, { path: '/client/again.md', text: plan(5, 'alpha') }]))
      .rejects.toMatchObject({ code: 'bad_request', status: 400, message: expect.stringContaining('Duplicate plan_id') });
    await expect(rawPost('/v1/plans/import', { path: '/tmp/x.md' }).then((r) => r.status)).resolves.toBe(400);
  });

  it('is open to the master and refused to a worker', async () => {
    const files = [{ path: '/client/8-gamma.md', text: plan(8, 'gamma') }];
    await expect(new ControlClient(dir, { credential: 'secret-a' }).importPlans(files)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(initProjectTaskStore(dir).getPlan(8)).toBeNull();
    expect(await new ControlClient(dir, { credential: 'secret-master' }).importPlans(files)).toMatchObject({ imported: [{ plan_id: 8 }] });
  });
});
