import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextEligibleTaskFromBacklog, nextEligibleTask } from './taskScheduler.ts';
import { computeWorkerCapacity } from './workerCapacity.ts';
import type { Agent } from '../types/index.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-task-scheduler-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function backlog(tasks: unknown[]) {
  return { version: '1', features: [{ ref: 'docs', title: 'Docs', tasks }] };
}

describe('nextEligibleTaskFromBacklog', () => {
  it('returns first todo task with ready dispatch state', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', planning_state: 'ready_for_dispatch' },
      { ref: 'docs/b', title: 'B', status: 'todo', planning_state: 'ready_for_dispatch' },
    ]), { agent_id: 'worker-01', role: 'worker' } as Agent);
    expect(taskRef).toBe('docs/a');
  });

  it('skips tasks blocked by planning_state', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', planning_state: 'archived' },
      { ref: 'docs/b', title: 'B', status: 'todo', planning_state: 'ready_for_dispatch' },
    ]), { agent_id: 'worker-01', role: 'worker' } as Agent);
    expect(taskRef).toBe('docs/b');
  });

  it('respects owner affinity', () => {
    const tasks = [
      { ref: 'docs/a', title: 'A', status: 'todo', owner: 'worker-02' },
      { ref: 'docs/b', title: 'B', status: 'todo' },
    ];
    expect(nextEligibleTaskFromBacklog(backlog(tasks), { agent_id: 'worker-01', role: 'worker' } as Agent)).toBe('docs/b');
    expect(nextEligibleTaskFromBacklog(backlog(tasks), { agent_id: 'worker-02', role: 'worker' } as Agent)).toBe('docs/a');
  });

  it('enforces dependencies done/released', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/base', title: 'Base', status: 'done' },
      { ref: 'docs/dep', title: 'Dep', status: 'todo', depends_on: ['docs/base'] },
      { ref: 'docs/blocked', title: 'Blocked', status: 'todo', depends_on: ['docs/missing'] },
    ]), { agent_id: 'worker-01', role: 'worker' } as Agent);
    expect(taskRef).toBe('docs/dep');
  });

  it('returns null when nothing is eligible', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'claimed' },
      { ref: 'docs/b', title: 'B', status: 'blocked' },
    ]), { agent_id: 'worker-01', role: 'worker' } as Agent);
    expect(taskRef).toBeNull();
  });

  it('prioritizes critical over normal when both are eligible', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/normal', title: 'Normal', status: 'todo', priority: 'normal' },
      { ref: 'docs/critical', title: 'Critical', status: 'todo', priority: 'critical' },
    ]), { agent_id: 'worker-01', role: 'worker' } as Agent);
    expect(taskRef).toBe('docs/critical');
  });

  it('skips tasks already reserved earlier in the current dispatch tick', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', priority: 'critical' },
      { ref: 'docs/b', title: 'B', status: 'todo', priority: 'normal' },
    ]), { agent_id: 'worker-01', role: 'worker' } as Agent, {
      excludeTaskRefs: new Set(['docs/a']),
    });
    expect(taskRef).toBe('docs/b');
  });

  it('preserves original order for equal-priority tasks (stable)', () => {
    const taskRef = nextEligibleTaskFromBacklog(backlog([
      { ref: 'docs/a', title: 'A', status: 'todo', priority: 'high' },
      { ref: 'docs/b', title: 'B', status: 'todo', priority: 'high' },
    ]), { agent_id: 'worker-01', role: 'worker' } as Agent);
    expect(taskRef).toBe('docs/a');
  });
});

describe('computeWorkerCapacity via workerCapacity', () => {
  it('computes available worker capacity from active live workers instead of idle slots or only started runs', () => {
    // A booting worker (idle status, no session) counts against capacity
    // because it exists in the registry as a live worker.
    const booting = { agent_id: 'amber-anchor', role: 'worker', status: 'idle' } as Agent;
    // A running worker also counts.
    const running = { agent_id: 'amber-anvil', role: 'worker', status: 'running' } as Agent;
    // A master does not count against worker capacity.
    const master = { agent_id: 'master', role: 'master', status: 'running' } as Agent;

    const capacityWithTwo = computeWorkerCapacity([booting, running, master], 3);
    expect(capacityWithTwo.active).toBe(2);
    expect(capacityWithTwo.available).toBe(1);

    // Removing the booting worker frees a slot immediately.
    const capacityWithOne = computeWorkerCapacity([running, master], 3);
    expect(capacityWithOne.active).toBe(1);
    expect(capacityWithOne.available).toBe(2);

    // An empty registry means full capacity is available.
    const capacityEmpty = computeWorkerCapacity([master], 3);
    expect(capacityEmpty.active).toBe(0);
    expect(capacityEmpty.available).toBe(3);
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
