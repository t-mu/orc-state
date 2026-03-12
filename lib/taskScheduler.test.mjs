import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextEligibleTaskFromBacklog, nextEligibleTask } from './taskScheduler.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-task-scheduler-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function backlog(tasks) {
  return { version: '1', epics: [{ ref: 'docs', title: 'Docs', tasks }] };
}

describe('nextEligibleTaskFromBacklog', () => {
  it('returns first todo task with ready dispatch state', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', planning_state: 'ready_for_dispatch' },
      { ref: 'docs/b', title: 'B', status: 'todo', planning_state: 'ready_for_dispatch' },
    ]), { agent_id: 'worker-01', role: 'worker' });
    expect(taskRef).toBe('docs/a');
  });

  it('skips tasks blocked by planning_state', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', planning_state: 'archived' },
      { ref: 'docs/b', title: 'B', status: 'todo', planning_state: 'ready_for_dispatch' },
    ]), { agent_id: 'worker-01', role: 'worker' });
    expect(taskRef).toBe('docs/b');
  });

  it('respects owner affinity', () => {
    const tasks = [
      { ref: 'docs/a', title: 'A', status: 'todo', owner: 'worker-02' },
      { ref: 'docs/b', title: 'B', status: 'todo' },
    ];
    expect(nextEligibleTaskFromBacklog(backlog(tasks), { agent_id: 'worker-01', role: 'worker' })).toBe('docs/b');
    expect(nextEligibleTaskFromBacklog(backlog(tasks), { agent_id: 'worker-02', role: 'worker' })).toBe('docs/a');
  });

  it('enforces dependencies done/released', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/base', title: 'Base', status: 'done' },
      { ref: 'docs/dep', title: 'Dep', status: 'todo', depends_on: ['docs/base'] },
      { ref: 'docs/blocked', title: 'Blocked', status: 'todo', depends_on: ['docs/missing'] },
    ]), { agent_id: 'worker-01', role: 'worker' });
    expect(taskRef).toBe('docs/dep');
  });

  it('returns null when nothing is eligible', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'claimed' },
      { ref: 'docs/b', title: 'B', status: 'blocked' },
    ]), { agent_id: 'worker-01', role: 'worker' });
    expect(taskRef).toBeNull();
  });

  it('prioritizes critical over normal when both are eligible', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/normal', title: 'Normal', status: 'todo', priority: 'normal' },
      { ref: 'docs/critical', title: 'Critical', status: 'todo', priority: 'critical' },
    ]), { agent_id: 'worker-01', role: 'worker' });
    expect(taskRef).toBe('docs/critical');
  });

  it('preserves original order for equal-priority tasks (stable)', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', priority: 'high' },
      { ref: 'docs/b', title: 'B', status: 'todo', priority: 'high' },
    ]), { agent_id: 'worker-01', role: 'worker' });
    expect(taskRef).toBe('docs/a');
  });
});

describe('nextEligibleTask', () => {
  it('uses pre-loaded backlog and agents when provided', () => {
    const preloadedBacklog = backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', task_type: 'implementation' },
    ]);
    const preloadedAgents = {
      version: '1',
      agents: [{ agent_id: 'worker-01', role: 'worker', capabilities: [] }],
    };
    expect(nextEligibleTask(dir, 'worker-01', { backlog: preloadedBacklog, agents: preloadedAgents }))
      .toBe('docs/a');
  });

  it('resolves agent by id from agents.json when given string agent id', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', task_type: 'implementation' },
    ])));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'reviewer-01', role: 'reviewer', capabilities: [], status: 'running' }],
    }));
    expect(nextEligibleTask(dir, 'reviewer-01')).toBe('docs/a');
  });

  it('falls back safely when agents.json is missing', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', task_type: 'implementation' },
    ])));
    expect(nextEligibleTask(dir, 'worker-01')).toBe('docs/a');
  });
});
