import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { writePlan } from './planAuthoring.ts';
import { previewSpec, publishSpec } from './planSpecTask.ts';
import { syncBacklogFromSpecs } from './backlogSync.ts';

// Simulates the full worktree → commit → merge-to-main flow that the /plan and
// /spec lifecycle verbs rely on. Uses a real git repo so we can verify specs
// are invisible to main's `backlog/` before merge and present after.

let mainRepo: string;
let stateDir: string;

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initMainRepo(): string {
  const repo = createTempStateDir('plan-spec-integration-main-');
  mkdirSync(join(repo, 'plans'), { recursive: true });
  mkdirSync(join(repo, 'backlog'), { recursive: true });
  mkdirSync(join(repo, '.orc-state'), { recursive: true });
  writeFileSync(
    join(repo, '.orc-state', 'backlog.json'),
    JSON.stringify({ version: '1', features: [] }, null, 2),
  );
  writeFileSync(join(repo, 'plans', '.gitkeep'), '');
  writeFileSync(join(repo, 'backlog', '.gitkeep'), '');
  run('git init -q -b main', repo);
  run('git config user.email test@example.com', repo);
  run('git config user.name tester', repo);
  run('git config commit.gpgsign false', repo);
  run('git add plans backlog', repo);
  run('git commit -q -m "init"', repo);
  return repo;
}

function addWorktree(repo: string, branch: string, name: string): string {
  const path = join(repo, '.worktrees', name);
  mkdirSync(join(repo, '.worktrees'), { recursive: true });
  run(`git worktree add -q -b ${branch} "${path}"`, repo);
  return path;
}

function mergeAndCleanup(repo: string, branch: string, worktreePath: string, message: string): void {
  // AGENTS.md ordering (branch-delete-before-worktree-remove) protects the
  // worker's cwd inside the worktree. The test driver sits outside the
  // worktree, so the reverse order is safe and sidesteps git's refusal to
  // delete a branch that is still checked out in a worktree.
  run(`git merge -q --no-ff ${branch} -m "${message}"`, repo);
  run(`git worktree remove --force "${worktreePath}"`, repo);
  run(`git branch -q -D ${branch}`, repo);
}

function listBacklogFiles(baseDir: string): string[] {
  const dir = join(baseDir, 'backlog');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^\d+[-.].*\.md$/.test(name)).sort();
}

beforeEach(() => {
  mainRepo = initMainRepo();
  stateDir = join(mainRepo, '.orc-state');
});

afterEach(() => {
  try { run('git worktree prune', mainRepo); } catch { /* ignore */ }
  cleanupTempStateDir(mainRepo);
});

describe('plan → spec → merge round-trip', () => {
  it('round-trips from plan_write → merge → spec_publish → merge and reaches main in correct shape', async () => {
    // Phase A — author a plan in worktree-1 and merge to main.
    const planBranch = 'task/plan-1';
    const planWt = addWorktree(mainRepo, planBranch, 'plan-1');

    const plan = await writePlan(
      {
        name: 'ingest-pipeline',
        title: 'Ingest Pipeline',
        objective: 'Stand up the new ingest pipeline so events flow end-to-end.',
        scope: '- Add the ingest worker.\n- Wire the dispatcher.',
        outOfScope: '- Backfilling historical events.',
        constraints: '- Must not alter the existing event schema.',
        affectedAreas: '- lib/ingest.ts\n- lib/dispatcher.ts',
        steps: [
          { title: 'Add worker skeleton', body: 'Create the worker module and a health check.' },
          { title: 'Wire dispatcher', body: 'Register the worker with the dispatcher.', dependsOn: [1] },
          { title: 'End-to-end smoke', body: 'Run one message through the whole path.', dependsOn: [2] },
        ],
      },
      { stateDir, plansDir: join(planWt, 'plans') },
    );

    expect(plan.planId).toBe(1);
    expect(plan.path).toBe(join(planWt, 'plans', '1-ingest-pipeline.md'));
    expect(existsSync(plan.path)).toBe(true);

    // Visible inside worktree, invisible to main before merge.
    expect(existsSync(join(mainRepo, 'plans', '1-ingest-pipeline.md'))).toBe(false);

    run('git add plans', planWt);
    run('git commit -q -m "chore(plan): add plan 1"', planWt);
    mergeAndCleanup(mainRepo, planBranch, planWt, 'merge plan 1');

    // After merge the plan is visible from main.
    expect(existsSync(join(mainRepo, 'plans', '1-ingest-pipeline.md'))).toBe(true);
    // Backlog has not been touched yet.
    expect(listBacklogFiles(mainRepo)).toEqual([]);

    // Phase B — publish specs in worktree-2, inspect invisibility pre-merge.
    const specBranch = 'task/spec-1';
    const specWt = addWorktree(mainRepo, specBranch, 'spec-1');

    const preview = previewSpec(1, { worktreePath: specWt, stateDir });
    expect(preview.tasks).toHaveLength(3);
    expect(preview.tasks.every((t) => t.feature === 'ingest-pipeline')).toBe(true);
    // previewSpec has zero side effects.
    expect(listBacklogFiles(mainRepo)).toEqual([]);
    expect(listBacklogFiles(specWt)).toEqual([]);

    const result = publishSpec(1, { confirm: true, worktreePath: specWt, stateDir });
    expect(result.createdRefs).toHaveLength(3);
    expect(result.createdRefs.every((ref) => ref.startsWith('ingest-pipeline/'))).toBe(true);

    // Specs exist inside the worktree …
    const wtSpecs = listBacklogFiles(specWt);
    expect(wtSpecs).toHaveLength(3);
    for (const file of wtSpecs) {
      const content = readFileSync(join(specWt, 'backlog', file), 'utf8');
      expect(content).toMatch(/^feature: ingest-pipeline$/m);
      expect(content).toMatch(/^review_level: (none|light|full)$/m);
      expect(content).toMatch(/^ref: ingest-pipeline\//m);
      expect(content).toMatch(/^status: todo$/m);
    }
    // … but NOT on main yet — the skill still has to commit and merge.
    expect(listBacklogFiles(mainRepo)).toEqual([]);
    // Staging dir was cleaned up on full success.
    expect(existsSync(join(stateDir, 'plan-staging', '1'))).toBe(false);

    run('git add plans backlog', specWt);
    run('git commit -q -m "feat(ingest-pipeline): spec tasks from plan 1"', specWt);
    mergeAndCleanup(mainRepo, specBranch, specWt, 'merge spec 1');

    // After merge: all three specs land in main's backlog/ in the expected shape.
    const mainSpecs = listBacklogFiles(mainRepo);
    expect(mainSpecs).toHaveLength(3);
    for (const file of mainSpecs) {
      const content = readFileSync(join(mainRepo, 'backlog', file), 'utf8');
      expect(content).toMatch(/^feature: ingest-pipeline$/m);
      expect(content).toMatch(/^review_level: (none|light|full)$/m);
    }
    // The plan file on main now has derived_task_refs populated.
    const mainPlan = readFileSync(join(mainRepo, 'plans', '1-ingest-pipeline.md'), 'utf8');
    expect(mainPlan).toMatch(/^derived_task_refs:\n  - ingest-pipeline\//m);

    // Coordinator auto-sync picks up the new specs on its next tick.
    const syncResult = syncBacklogFromSpecs(stateDir, join(mainRepo, 'backlog'));
    expect(syncResult.added_tasks).toBe(3);
    const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8')) as {
      features: Array<{ ref: string; tasks: Array<{ ref: string; review_level?: string }> }>;
    };
    const feature = backlog.features.find((f) => f.ref === 'ingest-pipeline');
    expect(feature).toBeDefined();
    expect(feature!.tasks).toHaveLength(3);
    for (const task of feature!.tasks) {
      expect(['none', 'light', 'full']).toContain(task.review_level);
    }
  });

  it('handles /spec conversational fallback (no plan id) end to end', async () => {
    // The conversational fallback re-uses plan_write to persist the chat-extracted
    // plan before preview/publish. It shares the same on-disk contract as the
    // saved-plan path, so the round-trip below uses plan_write directly with a
    // minimal, chat-like input shape.
    const branch = 'task/fallback-1';
    const wt = addWorktree(mainRepo, branch, 'fallback-1');

    const plan = await writePlan(
      {
        name: 'chat-extracted',
        title: 'Chat Extracted Feature',
        objective: 'Capture the plan that the user just pasted into chat.',
        scope: '- Persist the chat plan as a file.\n- Publish it as backlog specs.',
        outOfScope: '- Multi-plan batching.',
        constraints: '- No other state mutations.',
        affectedAreas: '- lib/chatExtract.ts',
        steps: [
          { title: 'Write draft', body: 'Create the draft module.' },
          { title: 'Run evals', body: 'Evaluate the draft.', dependsOn: [1] },
        ],
      },
      { stateDir, plansDir: join(wt, 'plans') },
    );
    expect(plan.planId).toBe(1);

    const result = publishSpec(1, { confirm: true, worktreePath: wt, stateDir });
    expect(result.createdRefs).toHaveLength(2);

    run('git add plans backlog', wt);
    run('git commit -q -m "feat(chat-extracted): plan + specs"', wt);
    mergeAndCleanup(mainRepo, branch, wt, 'merge fallback');

    const mainSpecs = listBacklogFiles(mainRepo);
    expect(mainSpecs).toHaveLength(2);
    for (const file of mainSpecs) {
      const content = readFileSync(join(mainRepo, 'backlog', file), 'utf8');
      expect(content).toMatch(/^feature: chat-extracted$/m);
      expect(content).toMatch(/^review_level: (none|light|full)$/m);
    }
  });

  it('propagates the plan feature slug and review_level into generated backlog specs', async () => {
    const branch = 'task/feature-propagation';
    const wt = addWorktree(mainRepo, branch, 'feature-propagation');

    await writePlan(
      {
        name: 'observability-upgrade',
        title: 'Observability Upgrade',
        objective: 'Add structured logging for the dispatcher.',
        scope: '- Emit structured events.\n- Record latency.',
        outOfScope: '- Tracing.',
        constraints: '- Keep stdout format stable for existing consumers.',
        affectedAreas: '- lib/dispatcher.ts',
        steps: [
          { title: 'Add structured events', body: 'Emit JSON log lines from dispatcher.' },
          { title: 'Record latency', body: 'Add a latency metric.', dependsOn: [1] },
          { title: 'Document format', body: 'Document the format in docs/logging.md.', dependsOn: [1] },
        ],
      },
      { stateDir, plansDir: join(wt, 'plans') },
    );

    const result = publishSpec(1, { confirm: true, worktreePath: wt, stateDir });

    expect(result.createdRefs).toHaveLength(3);
    for (const ref of result.createdRefs) {
      expect(ref.startsWith('observability-upgrade/')).toBe(true);
    }
    for (const file of result.createdFiles) {
      const content = readFileSync(file, 'utf8');
      const refMatch = /^ref:\s+(.+)$/m.exec(content);
      expect(refMatch?.[1]).toMatch(/^observability-upgrade\//);
      const featureMatch = /^feature:\s+(.+)$/m.exec(content);
      expect(featureMatch?.[1]).toBe('observability-upgrade');
      const reviewMatch = /^review_level:\s+(.+)$/m.exec(content);
      expect(reviewMatch).not.toBeNull();
      expect(['none', 'light', 'full']).toContain(reviewMatch![1]);
    }
  });

  it('specs are absent from main before merge and present after merge', async () => {
    const branch = 'task/visibility';
    const wt = addWorktree(mainRepo, branch, 'visibility');

    await writePlan(
      {
        name: 'visibility-check',
        title: 'Visibility Check',
        objective: 'Smoke-test pre- vs post-merge visibility from main.',
        scope: '- Create one spec.',
        outOfScope: '- Anything else.',
        constraints: '- No coordinator mutation.',
        affectedAreas: '- lib/demo.ts',
        steps: [{ title: 'Do the thing', body: 'Single-step plan.' }],
      },
      { stateDir, plansDir: join(wt, 'plans') },
    );

    publishSpec(1, { confirm: true, worktreePath: wt, stateDir });

    // Pre-merge: main/backlog is empty; worktree has one file.
    expect(listBacklogFiles(mainRepo)).toEqual([]);
    expect(listBacklogFiles(wt)).toHaveLength(1);

    run('git add plans backlog', wt);
    run('git commit -q -m "feat(visibility-check): one spec"', wt);
    mergeAndCleanup(mainRepo, branch, wt, 'merge visibility');

    // Post-merge: the spec is visible on main.
    expect(listBacklogFiles(mainRepo)).toHaveLength(1);
  });

  it('rejects a stale staging directory during an integration-style publish', async () => {
    const branch = 'task/stale-staging';
    const wt = addWorktree(mainRepo, branch, 'stale-staging');

    await writePlan(
      {
        name: 'stale-demo',
        title: 'Stale Demo',
        objective: 'Ensure stale staging hard-fails inside a real worktree flow.',
        scope: '- One step.',
        outOfScope: '- Anything else.',
        constraints: '- No override flags.',
        affectedAreas: '- lib/demo.ts',
        steps: [{ title: 'Do it', body: 'Body.' }],
      },
      { stateDir, plansDir: join(wt, 'plans') },
    );

    mkdirSync(join(stateDir, 'plan-staging', '1'), { recursive: true });

    expect(() => publishSpec(1, { confirm: true, worktreePath: wt, stateDir }))
      .toThrow(/staging directory already exists/);
    expect(listBacklogFiles(wt)).toEqual([]);
    expect(listBacklogFiles(mainRepo)).toEqual([]);

    // Cleanup so afterEach can remove the repo without noise.
    rmSync(join(stateDir, 'plan-staging', '1'), { recursive: true, force: true });
  });

  it('rejects republishing a plan that already carries derived_task_refs', async () => {
    const branch = 'task/already-published';
    const wt = addWorktree(mainRepo, branch, 'already-published');

    await writePlan(
      {
        name: 'republish-demo',
        title: 'Republish Demo',
        objective: 'Ensure republish fails cleanly in the integration flow.',
        scope: '- One step.',
        outOfScope: '- Anything else.',
        constraints: '- Regeneration unsupported.',
        affectedAreas: '- lib/demo.ts',
        steps: [{ title: 'First', body: 'First body.' }],
      },
      { stateDir, plansDir: join(wt, 'plans') },
    );

    publishSpec(1, { confirm: true, worktreePath: wt, stateDir });
    // Plan now has non-empty derived_task_refs inside the worktree.

    expect(() => publishSpec(1, { confirm: true, worktreePath: wt, stateDir }))
      .toThrow(/already has derived_task_refs/);
  });
});

describe('backward compatibility with non-plan backlog flows', () => {
  it('preserves existing backlog sync behavior for hand-authored specs alongside plan-generated ones', async () => {
    // Hand-authored spec lives alongside the plan-generated ones. The coordinator's
    // auto-sync must pick them both up without either flow interfering with the other.
    const handAuthored = join(mainRepo, 'backlog', '500-hand-authored.md');
    writeFileSync(
      handAuthored,
      [
        '---',
        'ref: legacy-work/500-hand-authored',
        'feature: legacy-work',
        'status: todo',
        '---',
        '',
        '# Task 500 — Hand Authored',
        '',
      ].join('\n'),
    );
    run('git add backlog', mainRepo);
    run('git commit -q -m "chore(legacy): hand-authored task"', mainRepo);

    // Sync once — legacy-work appears in the backlog.
    const firstSync = syncBacklogFromSpecs(stateDir, join(mainRepo, 'backlog'));
    expect(firstSync.added_tasks).toBe(1);
    const afterFirst = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8')) as {
      features: Array<{ ref: string; tasks: Array<{ ref: string }> }>;
    };
    expect(afterFirst.features.find((f) => f.ref === 'legacy-work')!.tasks[0].ref)
      .toBe('legacy-work/500-hand-authored');

    // Now introduce plan-generated specs in the same repo.
    const branch = 'task/plan-coexist';
    const wt = addWorktree(mainRepo, branch, 'plan-coexist');
    await writePlan(
      {
        name: 'new-plan-feature',
        title: 'New Plan Feature',
        objective: 'Ship the feature via plan + spec.',
        scope: '- Plan-generated work.',
        outOfScope: '- Hand-authored work.',
        constraints: '- Must coexist with legacy.',
        affectedAreas: '- lib/newplan.ts',
        steps: [{ title: 'Ship it', body: 'Single step.' }],
      },
      { stateDir, plansDir: join(wt, 'plans') },
    );
    publishSpec(1, { confirm: true, worktreePath: wt, stateDir });
    run('git add plans backlog', wt);
    run('git commit -q -m "feat(new-plan-feature): plan + specs"', wt);
    mergeAndCleanup(mainRepo, branch, wt, 'merge plan-coexist');

    // Second sync — plan-generated spec lands under its own feature; legacy is untouched.
    const secondSync = syncBacklogFromSpecs(stateDir, join(mainRepo, 'backlog'));
    expect(secondSync.added_tasks).toBe(1);
    const afterSecond = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8')) as {
      features: Array<{ ref: string; tasks: Array<{ ref: string }> }>;
    };
    const legacy = afterSecond.features.find((f) => f.ref === 'legacy-work');
    const planned = afterSecond.features.find((f) => f.ref === 'new-plan-feature');
    expect(legacy?.tasks.map((t) => t.ref)).toEqual(['legacy-work/500-hand-authored']);
    expect(planned?.tasks).toHaveLength(1);
    expect(planned!.tasks[0].ref.startsWith('new-plan-feature/')).toBe(true);

    // Third sync — idempotent. No drift between runs.
    const thirdSync = syncBacklogFromSpecs(stateDir, join(mainRepo, 'backlog'));
    expect(thirdSync.updated).toBe(false);
  });
});
