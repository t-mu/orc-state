import { describe, expect, it } from 'vitest';
import { planToBacklog, type PlanInput } from './planToBacklog.ts';

function basePlan(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    name: 'demo-feature',
    title: 'Demo Plan',
    startTaskNumber: 200,
    steps: [],
    ...overrides,
  };
}

describe('planToBacklog', () => {
  it('creates a linear dependency chain from saved plan steps', () => {
    const tasks = planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'Write draft', body: 'Create the draft file.' },
        { number: 2, title: 'Run evals', body: 'Evaluate the draft.', dependsOn: [1] },
        { number: 3, title: 'Iterate on feedback', body: 'Apply eval feedback.', dependsOn: [2] },
      ],
    }));

    expect(tasks).toHaveLength(3);
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[1].dependsOn).toEqual(['demo-feature/200-write-draft']);
    expect(tasks[2].dependsOn).toEqual(['demo-feature/201-run-evals']);
    expect(tasks.map((t) => t.slug)).toEqual([
      '200-write-draft',
      '201-run-evals',
      '202-iterate-on-feedback',
    ]);
  });

  it('keeps independent steps parallel when no dependency exists', () => {
    const tasks = planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'Write CI yaml', body: 'Author the pipeline.' },
        { number: 2, title: 'Write deploy yaml', body: 'Author the deploy.' },
        { number: 3, title: 'Set env vars', body: 'Populate secrets.' },
      ],
    }));

    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task.dependsOn).toEqual([]);
    }
  });

  it('uses explicit dependency cues from the plan artifact', () => {
    const tasks = planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'Write CI yaml', body: 'Author the pipeline.' },
        { number: 2, title: 'Write deploy yaml', body: 'Author the deploy.' },
        { number: 3, title: 'Set env vars', body: 'Populate secrets.' },
        { number: 4, title: 'Test pipeline', body: 'Run end-to-end smoke.', dependsOn: [1, 2, 3] },
      ],
    }));

    expect(tasks[3].dependsOn).toEqual([
      'demo-feature/200-write-ci-yaml',
      'demo-feature/201-write-deploy-yaml',
      'demo-feature/202-set-env-vars',
    ]);
  });

  it('groups tightly coupled steps into one proposed backlog task', () => {
    const tasks = planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'Add schema field', body: 'Extend schema.', groupId: 'schema-bundle' },
        { number: 2, title: 'Update JSON fixtures', body: 'Regenerate fixtures.', groupId: 'schema-bundle' },
        { number: 3, title: 'Wire new field into CLI', body: 'Surface in status.', dependsOn: [1] },
      ],
    }));

    expect(tasks).toHaveLength(2);
    expect(tasks[0].stepNumbers).toEqual([1, 2]);
    expect(tasks[0].slug).toBe('200-add-schema-field');
    expect(tasks[1].stepNumbers).toEqual([3]);
    expect(tasks[1].dependsOn).toEqual(['demo-feature/200-add-schema-field']);
  });

  it('treats a single-step plan as one independent task', () => {
    const tasks = planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'One-shot fix', body: 'Only one step.' },
      ],
    }));

    expect(tasks).toHaveLength(1);
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[0].stepNumbers).toEqual([1]);
  });

  it('stamps every proposed task with feature = plan.name', () => {
    const tasks = planToBacklog(basePlan({
      name: 'lifecycle-verbs',
      steps: [
        { number: 1, title: 'Step A', body: 'Body A.' },
        { number: 2, title: 'Step B', body: 'Body B.', dependsOn: [1] },
      ],
    }));

    expect(tasks.every((t) => t.feature === 'lifecycle-verbs')).toBe(true);
    expect(tasks[1].dependsOn).toEqual(['lifecycle-verbs/200-step-a']);
  });

  it('defaults reviewLevel to full and escalates to the highest specified level within a group', () => {
    const tasks = planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'Docs tweak', body: 'Update a doc.', reviewLevel: 'none' },
        { number: 2, title: 'Refactor', body: 'Change internals.' },
        { number: 3, title: 'Mixed bundle A', body: 'Light change.', groupId: 'mix', reviewLevel: 'light' },
        { number: 4, title: 'Mixed bundle B', body: 'Schema change.', groupId: 'mix', reviewLevel: 'full' },
      ],
    }));

    expect(tasks).toHaveLength(3);
    expect(tasks[0].reviewLevel).toBe('none');
    expect(tasks[1].reviewLevel).toBe('full');
    expect(tasks[2].reviewLevel).toBe('full');
  });

  it('drops intra-group dependencies when grouping merges them', () => {
    const tasks = planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'Part one', body: 'First half.', groupId: 'bundle' },
        { number: 2, title: 'Part two', body: 'Second half.', groupId: 'bundle', dependsOn: [1] },
      ],
    }));

    expect(tasks).toHaveLength(1);
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[0].stepNumbers).toEqual([1, 2]);
  });

  it('rejects unknown dependency targets', () => {
    expect(() => planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'Only step', body: 'Body.', dependsOn: [99] },
      ],
    }))).toThrow(/unknown step 99/);
  });

  it('rejects duplicate step numbers', () => {
    expect(() => planToBacklog(basePlan({
      steps: [
        { number: 1, title: 'One', body: 'Body.' },
        { number: 1, title: 'One again', body: 'Body.' },
      ],
    }))).toThrow(/duplicate step number 1/);
  });
});
