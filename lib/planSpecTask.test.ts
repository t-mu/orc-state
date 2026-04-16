import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { previewSpec, publishSpec } from './planSpecTask.ts';

let workspace: string;
let plansDir: string;
let backlogDir: string;
let stagingRoot: string;
let orcStateDir: string;

function writePlan({
  planId = 1,
  name = 'demo-feature',
  title = 'Demo Plan',
  derivedTaskRefs = '[]',
  bodySteps = [
    { number: 1, title: 'Write draft', body: 'Create the draft file.' },
    { number: 2, title: 'Run evals', body: 'Evaluate the draft.', depends: [1] },
    { number: 3, title: 'Iterate on feedback', body: 'Apply feedback.', depends: [2] },
  ] as Array<{ number: number; title: string; body: string; depends?: number[] }>,
  filename,
}: Partial<{
  planId: number;
  name: string;
  title: string;
  derivedTaskRefs: string;
  bodySteps: Array<{ number: number; title: string; body: string; depends?: number[] }>;
  filename: string;
}> = {}): string {
  const stepMd = bodySteps
    .map((step) => {
      const depsLine = step.depends && step.depends.length > 0
        ? `\n\nDepends on: ${step.depends.join(', ')}`
        : '';
      return `### Step ${step.number} — ${step.title}\n\n${step.body}${depsLine}`;
    })
    .join('\n\n');

  const content = `---
plan_id: ${planId}
name: ${name}
title: ${title}
created_at: 2026-04-16T00:00:00Z
updated_at: 2026-04-16T00:00:00Z
derived_task_refs: ${derivedTaskRefs}
---

# ${title}

## Objective

Ship the sample feature.

## Scope

- Outcome A.

## Out of Scope

- Thing B.

## Constraints

- Keep API stable.

## Affected Areas

- lib/foo.ts

## Implementation Steps

${stepMd}
`;
  const fn = filename ?? `${planId}-${name}.md`;
  const path = join(plansDir, fn);
  writeFileSync(path, content, 'utf8');
  return path;
}

beforeEach(() => {
  workspace = createTempStateDir('plan-spec-task-');
  plansDir = join(workspace, 'plans');
  backlogDir = join(workspace, 'backlog');
  orcStateDir = join(workspace, '.orc-state');
  stagingRoot = join(orcStateDir, 'plan-staging');
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(backlogDir, { recursive: true });
  mkdirSync(orcStateDir, { recursive: true });
});

afterEach(() => {
  cleanupTempStateDir(workspace);
});

describe('previewSpec', () => {
  it('returns the proposal without side effects', () => {
    writePlan({ planId: 7 });
    const before = readdirSync(backlogDir);

    const preview = previewSpec(7, { plansDir, backlogDir });
    expect(preview.plan.planId).toBe(7);
    expect(preview.plan.name).toBe('demo-feature');
    expect(preview.tasks).toHaveLength(3);
    expect(preview.tasks.map((task) => task.feature)).toEqual([
      'demo-feature',
      'demo-feature',
      'demo-feature',
    ]);
    expect(preview.tasks[1].dependsOn).toEqual([preview.tasks[0].ref]);

    expect(readdirSync(backlogDir)).toEqual(before);
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('uses the next available task number derived from backlog/', () => {
    writeFileSync(join(backlogDir, '175-existing.md'), '# existing\n');
    writePlan({ planId: 2 });

    const preview = previewSpec(2, { plansDir, backlogDir });
    expect(preview.startTaskNumber).toBe(176);
    expect(preview.tasks[0].slug).toBe('176-write-draft');
  });

  it('fails when plan lookup cannot resolve the id', () => {
    expect(() => previewSpec(99, { plansDir, backlogDir })).toThrow(/plan_id 99/);
  });
});

describe('publishSpec', () => {
  it('hard-fails when confirm is not true', () => {
    writePlan({ planId: 1 });
    expect(() => publishSpec(1, { confirm: false as unknown as true, plansDir, backlogDir, stagingRoot }))
      .toThrow(/confirm must be true/);
    expect(() => publishSpec(1, { plansDir, backlogDir, stagingRoot } as never))
      .toThrow(/confirm must be true/);
    expect(readdirSync(backlogDir)).toEqual([]);
  });

  it('writes backlog specs with feature: <plan.name> into the worktree and updates the plan file', () => {
    const planPath = writePlan({ planId: 5, name: 'demo-feature' });
    const result = publishSpec(5, { confirm: true, plansDir, backlogDir, stagingRoot });

    expect(result.createdRefs).toHaveLength(3);
    expect(result.createdFiles).toHaveLength(3);
    expect(result.planPath).toBe(planPath);

    for (const file of result.createdFiles) {
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, 'utf8');
      expect(content).toMatch(/^---\s*\nref: demo-feature\//m);
      expect(content).toMatch(/^feature: demo-feature$/m);
      expect(content).toMatch(/^review_level: (none|light|full)$/m);
      expect(content).toMatch(/^status: todo$/m);
    }

    const updatedPlan = readFileSync(planPath, 'utf8');
    expect(updatedPlan).toMatch(/^derived_task_refs:\n  - demo-feature\//m);
    for (const ref of result.createdRefs) {
      expect(updatedPlan.includes(`  - ${ref}`)).toBe(true);
    }

    expect(existsSync(join(stagingRoot, '5'))).toBe(false);
  });

  it('does NOT mutate .orc-state/backlog.json and does NOT run git', () => {
    writePlan({ planId: 3 });
    // Seed an existing backlog.json; assert it is untouched.
    const backlogJsonPath = join(orcStateDir, 'backlog.json');
    const originalBacklog = { version: '1', features: [] };
    writeFileSync(backlogJsonPath, JSON.stringify(originalBacklog, null, 2));
    const originalMtime = readFileSync(backlogJsonPath, 'utf8');

    publishSpec(3, { confirm: true, plansDir, backlogDir, stagingRoot });

    expect(readFileSync(backlogJsonPath, 'utf8')).toBe(originalMtime);
    // No .git directory was ever created by publishSpec.
    expect(existsSync(join(workspace, '.git'))).toBe(false);
  });

  it('rejects a stale staging directory for the same plan id', () => {
    writePlan({ planId: 9 });
    mkdirSync(join(stagingRoot, '9'), { recursive: true });
    expect(() => publishSpec(9, { confirm: true, plansDir, backlogDir, stagingRoot }))
      .toThrow(/staging directory already exists/);
    expect(readdirSync(backlogDir)).toEqual([]);
  });

  it('rejects a concurrent publish on the same plan id (mkdir lock)', () => {
    writePlan({ planId: 11 });
    // Simulate "first publish still running" by creating the staging dir.
    mkdirSync(join(stagingRoot, '11'), { recursive: true });
    expect(() => publishSpec(11, { confirm: true, plansDir, backlogDir, stagingRoot }))
      .toThrow(/staging directory already exists/);
  });

  it('fails when the plan already has non-empty derived_task_refs', () => {
    writePlan({
      planId: 4,
      derivedTaskRefs: `\n  - demo-feature/200-write-draft\n  - demo-feature/201-run-evals`,
    });
    expect(() => publishSpec(4, { confirm: true, plansDir, backlogDir, stagingRoot }))
      .toThrow(/already has derived_task_refs/);
    expect(readdirSync(backlogDir)).toEqual([]);
  });

  it('leaves derived_task_refs unchanged on partial publication failure', () => {
    const planPath = writePlan({ planId: 6 });

    // Make plansDir read-only so the tmp-write in updatePlanDerivedRefs fails
    // AFTER the backlog specs have already been renamed into place.
    chmodSync(plansDir, 0o555);

    try {
      expect(() => publishSpec(6, { confirm: true, plansDir, backlogDir, stagingRoot }))
        .toThrow(/publication failed/);
    } finally {
      chmodSync(plansDir, 0o755);
    }

    // derived_task_refs must still be empty because updatePlanDerivedRefs never committed.
    const updatedPlan = readFileSync(planPath, 'utf8');
    expect(updatedPlan).toMatch(/^derived_task_refs: \[\]$/m);
    // And some backlog files should have landed already — the error names them.
    expect(readdirSync(backlogDir).length).toBeGreaterThan(0);
  });

  it('derives filenames from the engine slug and startTaskNumber', () => {
    writeFileSync(join(backlogDir, '180-prior.md'), '# prior\n');
    writePlan({ planId: 8 });
    const result = publishSpec(8, { confirm: true, plansDir, backlogDir, stagingRoot });
    const basenames = result.createdFiles.map((p) => p.split('/').pop()).sort();
    expect(basenames).toEqual([
      '181-write-draft.md',
      '182-run-evals.md',
      '183-iterate-on-feedback.md',
    ].sort());
  });
});
