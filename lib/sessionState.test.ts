import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryEvents } from './eventLog.ts';
import { resetVolatileRuntimeStateForSession } from './sessionState.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-session-state-test-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [
        { ref: 'docs/task-1', title: 'Task 1', status: 'claimed' },
        { ref: 'docs/task-2', title: 'Task 2', status: 'in_progress' },
        { ref: 'docs/task-3', title: 'Task 3', status: 'done' },
      ],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      {
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'running',
        session_handle: 'pty:master',
        provider_ref: { pid: 123 },
        registered_at: '2026-01-01T00:00:00Z',
        last_heartbeat_at: '2026-01-01T00:00:00Z',
      },
      {
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: { pid: 456 },
        registered_at: '2026-01-01T00:00:00Z',
        last_heartbeat_at: '2026-01-01T00:00:00Z',
      },
    ],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [
      {
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      },
      {
        run_id: 'run-2',
        task_ref: 'docs/task-2',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      },
    ],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resetVolatileRuntimeStateForSession', () => {
  it('resets active runtime state and appends a session_started event', () => {
    const result = resetVolatileRuntimeStateForSession(dir);

    const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')) as { features: Array<{ tasks: Array<{ ref: string; status: string }> }> };
    const claims = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Array<{ state: string; failure_reason?: string }> };
    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as { agents: Array<{ agent_id: string; status: string; session_handle: string | null; provider_ref: unknown }> };

    expect(backlog.features[0].tasks.map((task) => [task.ref, task.status])).toEqual([
      ['docs/task-1', 'todo'],
      ['docs/task-2', 'todo'],
      ['docs/task-3', 'done'],
    ]);
    expect(claims.claims.map((claim) => [claim.state, claim.failure_reason])).toEqual([
      ['failed', 'session_reset'],
      ['failed', 'session_reset'],
    ]);
    expect(agents.agents.find((agent) => agent.agent_id === 'master')).toMatchObject({
      status: 'offline',
      session_handle: null,
      provider_ref: null,
    });
    expect(agents.agents.find((agent) => agent.agent_id === 'orc-1')).toMatchObject({
      status: 'idle',
      session_handle: null,
      provider_ref: null,
    });

    expect(result.reset_tasks).toBe(2);
    expect(result.reset_claims).toBe(2);
    expect(result.reset_agents).toBe(2);
    expect(result.session_id).toContain('session-');

    const events = queryEvents(dir, {});
    expect(events.at(-1)).toMatchObject({
      event: 'session_started',
      actor_type: 'human',
      actor_id: 'human',
      payload: {
        session_id: result.session_id,
        reset_tasks: 2,
        reset_claims: 2,
        reset_agents: 2,
      },
    });
  });
});
