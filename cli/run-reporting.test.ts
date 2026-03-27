import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DEFAULT_INPUT_REQUEST_TIMEOUT_MS } from '../lib/inputRequestConfig.ts';
import { queryEvents, appendSequencedEvent } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-run-reporting-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCli(script: string, args: string[] = []) {
  return spawnSync('node', ['--experimental-strip-types', `cli/${script}`, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function readClaims(): { claims: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
}

function readAgents(): { agents: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8'));
}

function readEvents(): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}

async function appendEventWithRetry(event: Parameters<typeof appendSequencedEvent>[1], attempts = 5) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      appendSequencedEvent(dir, event);
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint failed: events.seq')) {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw lastError;
}

function seedInputRequestState({ agentId = 'worker-01', runId = 'run-input-001' } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }] }],
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

function writeInputRequestClaim(overrides: Record<string, unknown>) {
  const existing = readClaims().claims[0];
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      ...existing,
      ...overrides,
    }],
  }));
}

function seedClaimedRun({ runId = 'run-test-001', agentId = 'worker-01', taskRef = 'docs/task-1' } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: taskRef, title: 'Task 1', status: 'claimed' }] }],
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
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: taskRef, title: 'Task 1', status: 'in_progress' }] }],
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

function seedFailedRun({ runId = 'run-test-001', agentId = 'worker-01', taskRef = 'docs/task-1' } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: taskRef, title: 'Task 1', status: 'todo' }] }],
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
      state: 'failed',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      finished_at: '2026-01-01T00:10:00.000Z',
      lease_expires_at: '2026-01-01T00:10:00.000Z',
      last_heartbeat_at: null,
      finalization_state: null,
      finalization_retry_count: 0,
      finalization_blocked_reason: null,
    }],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function claimSnapshot(runId: string): Record<string, unknown> | undefined {
  return readClaims().claims.find((claim) => claim.run_id === runId);
}

function assertClaimUnchanged(runId: string, before: Record<string, unknown> | undefined) {
  expect(claimSnapshot(runId)).toEqual(before);
}

describe('orc-run-start', () => {
  it('appends run_started and transitions claim to in_progress', () => {
    seedClaimedRun({ runId: 'run-abc-001', agentId: 'worker-01' });

    const result = runCli('run-start.ts', ['--run-id=run-abc-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_started');

    // Claim must now be in_progress — CLI updates claims.json synchronously so the
    // coordinator's enforceRunStartLifecycle sees the new state immediately.
    const claim = claimSnapshot('run-abc-001');
    expect(claim?.state).toBe('in_progress');
    expect(claim?.started_at).toBeTruthy();

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeUndefined();

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

  it('exits 0 without emitting a duplicate event when claim is already in_progress', () => {
    // Duplicate worker acknowledgements must remain harmless once the run has
    // already transitioned to in_progress.
    seedInProgressRun({ runId: 'run-dup-start', agentId: 'worker-01' });
    const eventsBefore = readEvents();

    const result = runCli('run-start.ts', ['--run-id=run-dup-start', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_started');
    // Claim stays in_progress — no state change.
    expect(claimSnapshot('run-dup-start')?.state).toBe('in_progress');
    // No duplicate event appended.
    expect(readEvents()).toHaveLength(eventsBefore.length);
  });
});

describe('orc-run-heartbeat', () => {
  it('appends a heartbeat event without mutating claims or agents', () => {
    seedInProgressRun({ runId: 'run-hb-001', agentId: 'worker-01' });
    const before = claimSnapshot('run-hb-001');

    const result = runCli('run-heartbeat.ts', ['--run-id=run-hb-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('heartbeat');

    assertClaimUnchanged('run-hb-001', before);

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeUndefined();

    const events = readEvents();
    expect(events.some((e) => e.event === 'heartbeat' && e.run_id === 'run-hb-001')).toBe(true);
  });

  it('exits with code 1 and prints usage when args are missing', () => {
    const result = runCli('run-heartbeat.ts', ['--run-id=run-hb-001']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('appends a stale heartbeat for a terminated run without error (CLI is lenient)', () => {
    // Worker-facing CLIs do not enforce state-machine rules — they append events
    // and let the coordinator decide what to do. A heartbeat from a worker that
    // does not yet know its run failed is accepted; the coordinator ignores it.
    seedFailedRun({ runId: 'run-stale-hb', agentId: 'worker-01' });

    const result = runCli('run-heartbeat.ts', ['--run-id=run-stale-hb', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    // Claim must remain failed — the CLI does not mutate state.
    expect(claimSnapshot('run-stale-hb')?.state).toBe('failed');
    const events = readEvents();
    expect(events.some((e) => e.event === 'heartbeat' && e.run_id === 'run-stale-hb')).toBe(true);
  });
});

// run-work-complete requires task status=done (gate enforced by task-mark-done).
// Override the backlog after seeding to set task status to 'done'.
function markTaskDone(taskRef = 'docs/task-1') {
  const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
  for (const feature of backlog.features) {
    const task = feature.tasks.find((t: { ref: string }) => t.ref === taskRef);
    if (task) task.status = 'done';
  }
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog));
}

describe('orc-run-work-complete', () => {
  it('emits a non-terminal work_complete event without mutating finalization state', () => {
    seedInProgressRun({ runId: 'run-work-001', agentId: 'worker-01' });
    markTaskDone();
    const before = claimSnapshot('run-work-001');

    const result = runCli('run-work-complete.ts', ['--run-id=run-work-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('work_complete');

    assertClaimUnchanged('run-work-001', before);

    const events = readEvents();
    expect(events.some((e) =>
      e.event === 'work_complete'
        && e.run_id === 'run-work-001'
        && (e.payload as Record<string, unknown>)?.status === 'awaiting_finalize'
        && (e.payload as Record<string, unknown>)?.retry_count === undefined)).toBe(true);
  });

  it('exits with code 1 and prints usage when args are missing', () => {
    const result = runCli('run-work-complete.ts', []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('accepts finalize_rebase_started and ready_to_merge through progress reporting without mutating claims', () => {
    seedInProgressRun({ runId: 'run-work-002', agentId: 'worker-01' });
    runCli('progress.ts', ['--event=work_complete', '--run-id=run-work-002', '--agent-id=worker-01']);
    const claims = readClaims();
    claims.claims[0].finalization_state = 'finalize_rebase_requested';
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claims));
    const before = claimSnapshot('run-work-002');

    const started = runCli('progress.ts', ['--event=finalize_rebase_started', '--run-id=run-work-002', '--agent-id=worker-01']);
    expect(started.status).toBe(0);

    const ready = runCli('progress.ts', ['--event=ready_to_merge', '--run-id=run-work-002', '--agent-id=worker-01']);
    expect(ready.status).toBe(0);

    assertClaimUnchanged('run-work-002', before);

    const events = readEvents();
    expect(events.some((e) => e.event === 'finalize_rebase_started' && (e.payload as Record<string, unknown>)?.status === 'finalize_rebase_in_progress')).toBe(true);
    expect(events.some((e) => e.event === 'ready_to_merge' && (e.payload as Record<string, unknown>)?.status === 'ready_to_merge')).toBe(true);
  });

  it('emits ready_to_merge when run-work-complete is called after a finalize rebase', () => {
    seedInProgressRun({ runId: 'run-work-003', agentId: 'worker-01' });
    markTaskDone();
    const claims = readClaims();
    claims.claims[0].finalization_state = 'finalize_rebase_in_progress';
    claims.claims[0].finalization_retry_count = 2;
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claims));
    const before = claimSnapshot('run-work-003');

    const result = runCli('run-work-complete.ts', ['--run-id=run-work-003', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ready_to_merge');

    assertClaimUnchanged('run-work-003', before);

    const events = readEvents();
    expect(events.some((e) =>
      e.event === 'ready_to_merge'
        && e.run_id === 'run-work-003'
        && (e.payload as Record<string, unknown>)?.status === 'ready_to_merge'
        && (e.payload as Record<string, unknown>)?.retry_count === undefined)).toBe(true);
  });
  it('still appends work_complete when the claim is still claimed', () => {
    seedClaimedRun({ runId: 'run-work-claimed', agentId: 'worker-01' });
    markTaskDone();

    const result = runCli('run-work-complete.ts', ['--run-id=run-work-claimed', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('work_complete');

    const events = readEvents();
    expect(events.some((e) => e.event === 'work_complete' && e.run_id === 'run-work-claimed')).toBe(true);
  });

  it('rejects run-work-complete when task is not marked done', () => {
    seedInProgressRun({ runId: 'run-work-gate', agentId: 'worker-01' });
    // Do NOT call markTaskDone() — task stays in_progress

    const result = runCli('run-work-complete.ts', ['--run-id=run-work-gate', '--agent-id=worker-01']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task not marked done');
    expect(result.stderr).toContain('orc task-mark-done');
  });
});

describe('orc-run-finish', () => {
  it('appends run_finished without mutating claims or agents', () => {
    seedInProgressRun({ runId: 'run-fin-001', agentId: 'worker-01' });
    const before = claimSnapshot('run-fin-001');

    const result = runCli('run-finish.ts', ['--run-id=run-fin-001', '--agent-id=worker-01']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_finished');

    assertClaimUnchanged('run-fin-001', before);

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeUndefined();

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
  it('appends run_failed with reason and policy without mutating claims or tasks', () => {
    seedInProgressRun({ runId: 'run-fail-001', agentId: 'worker-01' });
    const before = claimSnapshot('run-fail-001');

    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-001',
      '--agent-id=worker-01',
      '--reason=build error',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_failed');

    assertClaimUnchanged('run-fail-001', before);

    const agents = readAgents();
    expect(agents.agents[0].last_heartbeat_at).toBeUndefined();

    const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
    const task = backlog.features[0].tasks.find((t: Record<string, unknown>) => t.ref === 'docs/task-1');
    expect(task!.status).toBe('in_progress');

    const events = readEvents();
    expect(events.some((e) => e.event === 'run_failed' && e.run_id === 'run-fail-001')).toBe(true);
    const failedEvent = events.find((e) => e.event === 'run_failed' && e.run_id === 'run-fail-001');
    expect((failedEvent!.payload as Record<string, unknown>).reason).toBe('build error');
    expect((failedEvent!.payload as Record<string, unknown>).policy).toBe('requeue');
  });

  it('accepts --policy=block and records it only in the event payload', () => {
    seedInProgressRun({ runId: 'run-fail-002', agentId: 'worker-01' });

    const result = runCli('run-fail.ts', [
      '--run-id=run-fail-002',
      '--agent-id=worker-01',
      '--reason=unrecoverable error',
      '--policy=block',
    ]);

    expect(result.status).toBe(0);

    const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
    const task = backlog.features[0].tasks.find((t: Record<string, unknown>) => t.ref === 'docs/task-1');
    expect(task!.status).toBe('in_progress');
    const events = readEvents();
    const failedEvent = events.find((e) => e.event === 'run_failed' && e.run_id === 'run-fail-002');
    expect((failedEvent!.payload as Record<string, unknown>).policy).toBe('block');
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

  it('worker lifecycle CLIs do not touch .lock even when it is unusable', () => {
    const cases = [
      { script: 'run-start.ts', args: ['--run-id=run-lock-start', '--agent-id=worker-01'], seed: () => seedClaimedRun({ runId: 'run-lock-start', agentId: 'worker-01' }) },
      { script: 'run-heartbeat.ts', args: ['--run-id=run-lock-heartbeat', '--agent-id=worker-01'], seed: () => seedInProgressRun({ runId: 'run-lock-heartbeat', agentId: 'worker-01' }) },
      { script: 'run-finish.ts', args: ['--run-id=run-lock-finish', '--agent-id=worker-01'], seed: () => seedInProgressRun({ runId: 'run-lock-finish', agentId: 'worker-01' }) },
      { script: 'run-fail.ts', args: ['--run-id=run-lock-fail', '--agent-id=worker-01', '--reason=boom'], seed: () => seedInProgressRun({ runId: 'run-lock-fail', agentId: 'worker-01' }) },
      { script: 'run-work-complete.ts', args: ['--run-id=run-lock-complete', '--agent-id=worker-01'], seed: () => { seedInProgressRun({ runId: 'run-lock-complete', agentId: 'worker-01' }); markTaskDone(); } },
    ];

    for (const testCase of cases) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'orch-run-reporting-test-'));
      testCase.seed();
      mkdirSync(join(dir, '.lock'));
      const result = runCli(testCase.script, testCase.args);
      expect(result.status, `${testCase.script} stderr=${result.stderr}`).toBe(0);
    }
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    let eventsAfterRequest: Array<Record<string, unknown>> = [];
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
        && (event.payload as Record<string, unknown>)?.question === 'Continue?')).toBe(true);
    expect(readClaims().claims[0].input_state).toBeUndefined();

    appendSequencedEvent(dir, {
      ts: '2026-01-01T00:00:01.000Z',
      event: 'input_response',
      actor_type: 'human',
      actor_id: 'master',
      run_id: 'run-input-001',
      agent_id: 'worker-01',
      task_ref: 'docs/task-1',
      payload: { response: 'yes' },
    });

    const [code] = await once(child, 'close');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('yes');
    expect(stderr).toBe('');
    expect(readClaims().claims[0].input_state).toBeUndefined();
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
    expect(readClaims().claims[0].input_state).toBeUndefined();

    const timeoutFailure = readEvents().find((event) =>
      event.event === 'run_failed'
      && event.run_id === 'run-input-001'
      && event.agent_id === 'worker-01',
    );
    expect(timeoutFailure).toBeDefined();
    expect((timeoutFailure!.payload as Record<string, unknown>).reason).toBe('input_request_timeout');
    expect((timeoutFailure!.payload as Record<string, unknown>).code).toBe('ERR_INPUT_REQUEST_TIMEOUT');
    expect((timeoutFailure!.payload as Record<string, unknown>).policy).toBe('requeue');
  });

  it('defaults to the 1-hour timeout when omitted', () => {
    expect(DEFAULT_INPUT_REQUEST_TIMEOUT_MS).toBe(60 * 60 * 1000);
  });

  it('does not append a stale timeout failure when the run has already terminated elsewhere', async () => {
    seedInputRequestState();

    const child = spawn('node', [
      '--experimental-strip-types',
      'cli/run-input-request.ts',
      '--run-id=run-input-001',
      '--agent-id=worker-01',
      '--question=Continue?',
      '--timeout-ms=120',
      '--poll-ms=10',
    ], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (readEvents().some((event) => event.event === 'input_requested')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    writeInputRequestClaim({
      state: 'failed',
      finished_at: '2026-01-01T00:02:00.000Z',
      input_state: null,
    });

    const [code] = await once(child, 'close');
    expect(code).toBe(1);
    expect(stderr).toContain('Timed out waiting for input_response');

    const timedOutFailures = readEvents().filter((event) =>
      event.event === 'run_failed'
      && (event.payload as Record<string, unknown>)?.reason === 'input_request_timeout',
    );
    expect(timedOutFailures).toHaveLength(0);
  });

  it('returns a response that lands at the timeout boundary before emitting timeout failure', async () => {
    seedInputRequestState();

    const child = spawn('node', [
      '--experimental-strip-types',
      'cli/run-input-request.ts',
      '--run-id=run-input-001',
      '--agent-id=worker-01',
      '--question=Continue?',
      '--timeout-ms=80',
      '--poll-ms=40',
    ], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (readEvents().some((event) => event.event === 'input_requested')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    await appendEventWithRetry({
      ts: new Date().toISOString(),
      event: 'input_response',
      actor_type: 'human',
      actor_id: 'master',
      run_id: 'run-input-001',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { response: 'yes' },
    });

    const [code] = await once(child, 'close');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('yes');
    expect(stderr).toBe('');
    expect(readEvents().filter((event) =>
      event.event === 'run_failed'
      && (event.payload as Record<string, unknown>)?.reason === 'input_request_timeout',
    )).toHaveLength(0);
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
    expect(readClaims().claims[0].input_state).toBeUndefined();

    const events = readEvents();
    expect(events.some((event) =>
      event.event === 'input_response'
      && event.run_id === 'run-input-001'
      && event.agent_id === 'worker-01'
      && (event.payload as Record<string, unknown>)?.response === 'yes')).toBe(true);
  });
});
