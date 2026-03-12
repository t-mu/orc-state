import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-run-reporting-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCli(script, args = []) {
  return spawnSync('node', ['--experimental-strip-types', `cli/${script}`, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function readClaims() {
  return JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8'));
}

function readEvents() {
  const raw = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function seedInputRequestState({ agentId = 'worker-01', runId = 'run-input-001' } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: agentId, provider: 'claude', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: runId,
      task_ref: 'docs/task-1',
      agent_id: agentId,
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      last_heartbeat_at: null,
      finished_at: null,
      finalization_state: null,
      finalization_retry_count: 0,
      finalization_blocked_reason: null,
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function seedClaimedRun({ runId = 'run-test-001', agentId = 'worker-01', taskRef = 'docs/task-1' } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: taskRef, title: 'Task 1', status: 'claimed' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: agentId, provider: 'claude', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: runId,
      task_ref: taskRef,
      agent_id: agentId,
      state: 'claimed',
      claimed_at: '2026-01-01T00:00:00.000Z',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      last_heartbeat_at: null,
      started_at: null,
      finished_at: null,
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function seedInProgressRun({ runId = 'run-test-001', agentId = 'worker-01', taskRef = 'docs/task-1' } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: taskRef, title: 'Task 1', status: 'in_progress' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: agentId, provider: 'claude', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: runId,
      task_ref: taskRef,
      agent_id: agentId,
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      last_heartbeat_at: null,
      finished_at: null,
      finalization_state: null,
      finalization_retry_count: 0,
      finalization_blocked_reason: null,
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

describe('orc-run-start', () => {
  it('transitions claim from claimed to in_progress and emits run_started event', () => {
    seedClaimedRun({ runId: 'run-abc-001', agentId: 'worker-01' });

    const result = runCli('run-start.ts', ['--run-id=run-abc-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_started');

    const claims = readClaims();
    const claim = claims.claims.find((c) => c.run_id === 'run-abc-001');
    expect(claim.state).toBe('in_progress');
    expect(claim.started_at).toBeTruthy();

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeTruthy();

    const events = readEvents();
    expect(events.some((e) => e.event === 'run_started' && e.run_id === 'run-abc-001')).toBe(true);
  });

  it('exits with code 1 and prints usage when args are missing', () => {
    const result = runCli('run-start.ts', []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('exits with code 1 when run_id does not exist', () => {
    seedClaimedRun();
    const result = runCli('run-start.ts', ['--run-id=nonexistent', '--agent-id=worker-01']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error');
  });
});

describe('orc-run-heartbeat', () => {
  it('renews the lease and emits a heartbeat event', () => {
    seedInProgressRun({ runId: 'run-hb-001', agentId: 'worker-01' });

    const result = runCli('run-heartbeat.ts', ['--run-id=run-hb-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('heartbeat');

    const claims = readClaims();
    const claim = claims.claims.find((c) => c.run_id === 'run-hb-001');
    expect(claim.last_heartbeat_at).toBeTruthy();

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeTruthy();

    const events = readEvents();
    expect(events.some((e) => e.event === 'heartbeat' && e.run_id === 'run-hb-001')).toBe(true);
  });

  it('exits with code 1 and prints usage when args are missing', () => {
    const result = runCli('run-heartbeat.ts', ['--run-id=run-hb-001']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });
});

describe('orc-run-work-complete', () => {
  it('emits a non-terminal work_complete event and keeps the claim in_progress', () => {
    seedInProgressRun({ runId: 'run-work-001', agentId: 'worker-01' });

    const result = runCli('run-work-complete.ts', ['--run-id=run-work-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('work_complete');

    const claims = readClaims();
    const claim = claims.claims.find((c) => c.run_id === 'run-work-001');
    expect(claim.state).toBe('in_progress');
    expect(claim.finalization_state).toBe('awaiting_finalize');
    expect(claim.finalization_retry_count).toBe(0);
    expect(claim.finished_at).toBeNull();
    expect(claim.last_heartbeat_at).toBeTruthy();

    const events = readEvents();
    expect(events.some((e) =>
      e.event === 'work_complete'
        && e.run_id === 'run-work-001'
        && e.payload?.status === 'awaiting_finalize')).toBe(true);
  });

  it('exits with code 1 and prints usage when args are missing', () => {
    const result = runCli('run-work-complete.ts', []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('accepts finalize_rebase_started and ready_to_merge through progress reporting', () => {
    seedInProgressRun({ runId: 'run-work-002', agentId: 'worker-01' });
    runCli('progress.ts', ['--event=work_complete', '--run-id=run-work-002', '--agent-id=worker-01']);
    const claims = readClaims();
    claims.claims[0].finalization_state = 'finalize_rebase_requested';
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claims));

    const started = runCli('progress.ts', ['--event=finalize_rebase_started', '--run-id=run-work-002', '--agent-id=worker-01']);
    expect(started.status).toBe(0);

    const ready = runCli('progress.ts', ['--event=ready_to_merge', '--run-id=run-work-002', '--agent-id=worker-01']);
    expect(ready.status).toBe(0);

    const claim = readClaims().claims.find((entry) => entry.run_id === 'run-work-002');
    expect(claim.finalization_state).toBe('ready_to_merge');
    expect(claim.finalization_retry_count).toBe(1);

    const events = readEvents();
    expect(events.some((e) => e.event === 'finalize_rebase_started' && e.payload?.status === 'finalize_rebase_in_progress')).toBe(true);
    expect(events.some((e) => e.event === 'ready_to_merge' && e.payload?.status === 'ready_to_merge')).toBe(true);
  });

  it('emits ready_to_merge when run-work-complete is called after a finalize rebase', () => {
    seedInProgressRun({ runId: 'run-work-003', agentId: 'worker-01' });
    const claims = readClaims();
    claims.claims[0].finalization_state = 'finalize_rebase_in_progress';
    claims.claims[0].finalization_retry_count = 2;
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claims));

    const result = runCli('run-work-complete.ts', ['--run-id=run-work-003', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ready_to_merge');

    const claim = readClaims().claims.find((entry) => entry.run_id === 'run-work-003');
    expect(claim.finalization_state).toBe('ready_to_merge');
    expect(claim.finalization_retry_count).toBe(2);

    const events = readEvents();
    expect(events.some((e) =>
      e.event === 'ready_to_merge'
        && e.run_id === 'run-work-003'
        && e.payload?.status === 'ready_to_merge'
        && e.payload?.retry_count === 2)).toBe(true);
  });
});

describe('orc-run-finish', () => {
  it('transitions claim to done and marks task done', () => {
    seedInProgressRun({ runId: 'run-fin-001', agentId: 'worker-01' });

    const result = runCli('run-finish.ts', ['--run-id=run-fin-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_finished');

    const claims = readClaims();
    const claim = claims.claims.find((c) => c.run_id === 'run-fin-001');
    expect(claim.state).toBe('done');
    expect(claim.finished_at).toBeTruthy();

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeTruthy();

    const events = readEvents();
    expect(events.some((e) => e.event === 'run_finished' && e.run_id === 'run-fin-001')).toBe(true);
  });

  it('exits with code 1 and prints usage when args are missing', () => {
    const result = runCli('run-finish.ts', []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });
});

describe('orc-run-fail', () => {
  it('transitions claim to failed and requeues the task', () => {
    seedInProgressRun({ runId: 'run-fail-001', agentId: 'worker-01' });

    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-001',
      '--agent-id=worker-01',
      '--reason=build error',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_failed');

    const claims = readClaims();
    const claim = claims.claims.find((c) => c.run_id === 'run-fail-001');
    expect(claim.state).toBe('failed');
    expect(claim.failure_reason).toBe('build error');

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeTruthy();

    const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
    const task = backlog.epics[0].tasks.find((t) => t.ref === 'docs/task-1');
    expect(task.status).toBe('todo');

    const events = readEvents();
    expect(events.some((e) => e.event === 'run_failed' && e.run_id === 'run-fail-001')).toBe(true);
  });

  it('accepts --policy=block and blocks the task instead of requeueing', () => {
    seedInProgressRun({ runId: 'run-fail-002', agentId: 'worker-01' });

    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-002',
      '--agent-id=worker-01',
      '--reason=unrecoverable error',
      '--policy=block',
    ]);

    expect(result.status).toBe(0);

    const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
    const task = backlog.epics[0].tasks.find((t) => t.ref === 'docs/task-1');
    expect(task.status).toBe('blocked');
  });

  it('exits with code 1 and prints usage when args are missing', () => {
    const result = runCli('run-fail.ts', []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('exits with code 1 when --policy is invalid', () => {
    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-003',
      '--agent-id=worker-01',
      '--policy=blok',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid policy');
    expect(result.stderr).toContain('requeue');
    expect(result.stderr).toContain('block');
  });

  it('accepts --policy=requeue without validation error', () => {
    seedInProgressRun({ runId: 'run-fail-004', agentId: 'worker-01' });
    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-004',
      '--agent-id=worker-01',
      '--policy=requeue',
    ]);
    expect(result.status).toBe(0);
  });
});

describe('orc-run-input-request', () => {
  it('appends input_requested and prints the matching input_response payload', async () => {
    seedInputRequestState();

    const child = spawn('node', [
      '--experimental-strip-types',
      'cli/run-input-request.ts',
      '--run-id=run-input-001',
      '--agent-id=worker-01',
      '--question=Continue?',
      '--timeout-ms=5000',
      '--poll-ms=20',
    ], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    let eventsAfterRequest = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      eventsAfterRequest = readEvents();
      if (eventsAfterRequest.some((event) => event.event === 'input_requested')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(eventsAfterRequest.some((event) =>
      event.event === 'input_requested'
        && event.run_id === 'run-input-001'
        && event.agent_id === 'worker-01'
        && event.task_ref === 'docs/task-1'
        && event.payload?.question === 'Continue?')).toBe(true);
    expect(readClaims().claims[0].input_state).toBe('awaiting_input');

    writeFileSync(join(dir, 'events.jsonl'), `${readFileSync(join(dir, 'events.jsonl'), 'utf8')}${JSON.stringify({
      seq: eventsAfterRequest.length + 1,
      ts: '2026-01-01T00:00:01.000Z',
      event: 'input_response',
      actor_type: 'human',
      actor_id: 'master',
      run_id: 'run-input-001',
      agent_id: 'worker-01',
      task_ref: 'docs/task-1',
      payload: { response: 'yes' },
    })}\n`);

    const [code] = await once(child, 'close');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('yes');
    expect(stderr).toBe('');
    expect(readClaims().claims[0].input_state).toBeNull();
  });

  it('exits 1 with a descriptive timeout message when no response arrives', () => {
    seedInputRequestState();
    const result = runCli('run-input-request.ts', [
      '--run-id=run-input-001',
      '--agent-id=worker-01',
      '--question=Continue?',
      '--timeout-ms=50',
      '--poll-ms=10',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Timed out waiting for input_response');
    expect(readClaims().claims[0].input_state).toBeNull();
  });

  it('exits 1 with usage when required args are missing', () => {
    const result = runCli('run-input-request.ts', ['--run-id=run-input-003']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc-run-input-request');
  });

  it('writes input_response through the dedicated response CLI', () => {
    seedInputRequestState({ runId: 'run-input-001' });
    runCli('run-input-request.ts', [
      '--run-id=run-input-001',
      '--agent-id=worker-01',
      '--question=Continue?',
      '--timeout-ms=10',
      '--poll-ms=5',
    ]);

    const result = runCli('run-input-respond.ts', [
      '--run-id=run-input-001',
      '--agent-id=worker-01',
      '--response=yes',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('input_response');
    expect(readClaims().claims[0].input_state).toBeNull();

    const events = readEvents();
    expect(events.some((event) =>
      event.event === 'input_response'
      && event.run_id === 'run-input-001'
      && event.agent_id === 'worker-01'
      && event.payload?.response === 'yes')).toBe(true);
  });
});
