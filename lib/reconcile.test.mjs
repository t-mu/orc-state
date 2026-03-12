import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileState } from './reconcile.ts';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-reconcile-test-'));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeState({ tasks, claims }) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
}

describe('reconcileState', () => {
  it('is a no-op when state is consistent', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const backlog = readJson(join(dir, 'backlog.json'));
    const claims = readJson(join(dir, 'claims.json'));
    expect(backlog.epics[0].tasks[0].status).toBe('claimed');
    expect(claims.claims[0].state).toBe('claimed');
  });

  it('repairs task status when active claim is in_progress', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const backlog = readJson(join(dir, 'backlog.json'));
    expect(backlog.epics[0].tasks[0].status).toBe('in_progress');
  });

  it('resets task to todo when task is active but claim is terminal', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'a1',
        state: 'done',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const backlog = readJson(join(dir, 'backlog.json'));
    expect(backlog.epics[0].tasks[0].status).toBe('todo');
  });

  it('resets task to todo when no active claim exists', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [],
    });

    reconcileState(dir);
    const backlog = readJson(join(dir, 'backlog.json'));
    expect(backlog.epics[0].tasks[0].status).toBe('todo');
  });

  it('marks older duplicate active claim as failed', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [
        {
          run_id: 'run-old',
          task_ref: 'docs/task-1',
          agent_id: 'a1',
          state: 'claimed',
          claimed_at: '2026-01-01T00:00:00.000Z',
          lease_expires_at: '2026-01-01T01:00:00.000Z',
        },
        {
          run_id: 'run-new',
          task_ref: 'docs/task-1',
          agent_id: 'a2',
          state: 'claimed',
          claimed_at: '2026-01-01T00:10:00.000Z',
          lease_expires_at: '2026-01-01T01:10:00.000Z',
        },
      ],
    });

    reconcileState(dir);
    const claims = readJson(join(dir, 'claims.json')).claims;
    expect(claims.find((c) => c.run_id === 'run-old')?.state).toBe('failed');
    expect(claims.find((c) => c.run_id === 'run-new')?.state).toBe('claimed');
  });

  it('marks orphan active claim as failed', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
      claims: [{
        run_id: 'run-orphan',
        task_ref: 'docs/missing-task',
        agent_id: 'a1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T01:00:00.000Z',
      }],
    });

    reconcileState(dir);
    const claims = readJson(join(dir, 'claims.json')).claims;
    expect(claims[0].state).toBe('failed');
  });

  it('is idempotent', () => {
    writeState({
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [],
    });

    reconcileState(dir);
    const firstBacklog = readFileSync(join(dir, 'backlog.json'), 'utf8');
    const firstClaims = readFileSync(join(dir, 'claims.json'), 'utf8');
    reconcileState(dir);
    const secondBacklog = readFileSync(join(dir, 'backlog.json'), 'utf8');
    const secondClaims = readFileSync(join(dir, 'claims.json'), 'utf8');

    expect(secondBacklog).toBe(firstBacklog);
    expect(secondClaims).toBe(firstClaims);
  });
});
