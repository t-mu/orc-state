import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

function writeSpec(baseDir: string, name: string, { ref, feature, status, title = 'Example Title', review_level }: { ref?: string; feature?: string; status?: string; title?: string; review_level?: string } = {}) {
  const frontmatter = [
    '---',
    ...(ref ? [`ref: ${ref}`] : []),
    ...(feature ? [`feature: ${feature}`] : []),
    ...(status ? [`status: ${status}`] : []),
    ...(review_level !== undefined ? [`review_level: ${review_level}`] : []),
    '---',
    '',
  ].join('\n');
  writeFileSync(join(baseDir, 'backlog', name), `${frontmatter}# Task 999 — ${title}\n`);
}

function writeBacklog(baseDir: string, backlog: unknown) {
  writeFileSync(join(baseDir, '.orc-state', 'backlog.json'), JSON.stringify(backlog, null, 2));
}

function readBacklog(baseDir: string): { features: Array<{ ref: string; tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(baseDir, '.orc-state', 'backlog.json'), 'utf8'));
}

beforeEach(() => {
  vi.resetModules();
  dir = createTempStateDir('backlog-sync-');
  mkdirSync(join(dir, 'backlog'), { recursive: true });
  mkdirSync(join(dir, '.orc-state'), { recursive: true });
});

afterEach(() => {
  cleanupTempStateDir(dir);
  delete process.env.ORCH_STATE_DIR;
  delete process.env.ORC_REPO_ROOT;
});

describe('syncBacklogFromSpecs', () => {
  it('adds a missing task from a spec file with status todo', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'todo',
      title: 'Rebuild Backlog',
    });
    writeBacklog(dir, { version: '1', features: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 1,
      updated_tasks: 0,
      added_features: 0,
    });
    expect(readBacklog(dir).features[0].tasks).toEqual([
      {
        ref: 'orch/task-155-example',
        title: 'Rebuild Backlog',
        status: 'todo',
        task_type: 'implementation',
      },
    ]);
  });

  it('accepts cancelled as a valid spec status and syncs it into runtime backlog', async () => {
    writeSpec(dir, '156-cancelled.md', {
      ref: 'orch/task-156-cancelled',
      feature: 'orch',
      status: 'cancelled',
      title: 'Cancelled Task',
    });
    writeBacklog(dir, { version: '1', features: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result.added_tasks).toBe(1);
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('cancelled');
  });

  it('adds a missing feature when a spec references an unknown feature', async () => {
    writeSpec(dir, '200-other.md', {
      ref: 'other/task-200-example',
      feature: 'other',
      status: 'done',
      title: 'Other Work',
    });
    writeBacklog(dir, { version: '1', features: [] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));
    const backlog = readBacklog(dir);

    expect(result.added_features).toBe(1);
    expect(backlog.features).toEqual([
      {
        ref: 'other',
        title: 'Other',
        tasks: [
          {
            ref: 'other/task-200-example',
            title: 'Other Work',
            status: 'done',
            task_type: 'implementation',
          },
        ],
      },
    ]);
  });

  it('repairs active task metadata without overwriting active runtime status', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'done',
      title: 'Spec Wants Done',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'orch',
        title: 'Orch',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Original Title',
          status: 'in_progress',
          task_type: 'implementation',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));
    const backlog = readBacklog(dir);

    expect(result).toEqual({
      updated: true,
      added_tasks: 0,
      updated_tasks: 1,
      added_features: 0,
    });
    expect(backlog.features[0].tasks[0]).toEqual({
      ref: 'orch/task-155-example',
      title: 'Spec Wants Done',
      status: 'in_progress',
      task_type: 'implementation',
    });
  });

  it('updates an existing todo task to match the spec status', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'done',
      title: 'Spec Wants Done',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'orch',
        title: 'Orch',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Original Title',
          status: 'todo',
          task_type: 'implementation',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 0,
      updated_tasks: 1,
      added_features: 0,
    });
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('done');
  });

  it('updates a blocked task to match the spec status', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'done',
      title: 'Spec Wants Done',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'orch',
        title: 'Orch',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Original Title',
          status: 'blocked',
          task_type: 'implementation',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 0,
      updated_tasks: 1,
      added_features: 0,
    });
    expect(readBacklog(dir).features[0].tasks[0].status).toBe('done');
  });

  it('is idempotent when called twice with the same specs', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'todo',
      title: 'Same Result',
    });
    writeBacklog(dir, { version: '1', features: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const first = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));
    const snapshot = readFileSync(join(dir, '.orc-state', 'backlog.json'), 'utf8');
    const second = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(first.updated).toBe(true);
    expect(second).toEqual({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_features: 0,
    });
    expect(readFileSync(join(dir, '.orc-state', 'backlog.json'), 'utf8')).toBe(snapshot);
  });

  it('skips spec files without ref, feature, or status fields', async () => {
    writeSpec(dir, '155-missing-ref.md', { feature: 'orch', status: 'todo' });
    writeSpec(dir, '156-missing-feature.md', { ref: 'orch/task-156-example', status: 'todo' });
    writeSpec(dir, '157-missing-status.md', { ref: 'orch/task-157-example', feature: 'orch' });
    writeSpec(dir, '158-invalid-status.md', { ref: 'orch/task-158-example', feature: 'orch', status: 'unknown' });
    writeBacklog(dir, { version: '1', features: [] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result).toEqual({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_features: 0,
    });
    expect(readBacklog(dir)).toEqual({ version: '1', features: [] });
  });

  it('does not import body lines that only look like frontmatter keys', async () => {
    writeFileSync(
      join(dir, 'backlog', '159-body-keys.md'),
      [
        '---',
        'feature: orch',
        '---',
        '',
        '# Task 159 — Body Keys',
        '',
        'ref: orch/task-159-body-keys',
        'status: done',
      ].join('\n'),
    );
    writeBacklog(dir, { version: '1', features: [] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result.updated).toBe(false);
    expect(readBacklog(dir)).toEqual({ version: '1', features: [] });
  });

  it('moves a non-active task under the feature declared by the spec', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'done',
      title: 'Spec Wants Orch',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'wrong',
        title: 'Wrong',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Original Title',
          status: 'blocked',
          task_type: 'implementation',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));
    const backlog = readBacklog(dir);

    expect(result.updated).toBe(true);
    expect(backlog.features.find(feature => feature.ref === 'wrong')?.tasks ?? []).toEqual([]);
    expect(backlog.features.find(feature => feature.ref === 'orch')?.tasks).toEqual([
      {
        ref: 'orch/task-155-example',
        title: 'Spec Wants Orch',
        status: 'done',
        task_type: 'implementation',
      },
    ]);
  });

  it('uses recursive active-spec discovery and ignores backlog/legacy', async () => {
    mkdirSync(join(dir, 'backlog', 'feature-x'), { recursive: true });
    mkdirSync(join(dir, 'backlog', 'legacy'), { recursive: true });
    writeFileSync(
      join(dir, 'backlog', 'feature-x', '160-sample.md'),
      '---\nref: orch/task-160-sample\nfeature: orch\nstatus: todo\n---\n\n# Task 160 — Recursive Spec\n',
    );
    writeFileSync(
      join(dir, 'backlog', 'legacy', '001-old.md'),
      '---\nref: orch/task-001-old\nfeature: orch\nstatus: done\n---\n\n# Task 1 — Legacy\n',
    );
    writeBacklog(dir, { version: '1', features: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 1,
      updated_tasks: 0,
      added_features: 0,
    });
    expect(readBacklog(dir).features[0].tasks).toEqual([
      {
        ref: 'orch/task-160-sample',
        title: 'Recursive Spec',
        status: 'todo',
        task_type: 'implementation',
      },
    ]);
  });

  it('repairs authoritative title metadata for existing inactive tasks', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'todo',
      title: 'Spec Title',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'orch',
        title: 'Orch',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Wrong Title',
          status: 'todo',
          task_type: 'implementation',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 0,
      updated_tasks: 1,
      added_features: 0,
    });
    expect(readBacklog(dir).features[0].tasks[0].title).toBe('Spec Title');
  });

  it('repairs active task feature/title drift without changing active status', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'done',
      title: 'Spec Title',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'wrong',
        title: 'Wrong',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Wrong Title',
          status: 'claimed',
          task_type: 'implementation',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));
    const backlog = readBacklog(dir);

    expect(result).toEqual({
      updated: true,
      added_tasks: 0,
      updated_tasks: 1,
      added_features: 1,
    });
    expect(backlog.features.find((feature) => feature.ref === 'wrong')?.tasks ?? []).toEqual([]);
    expect(backlog.features.find((feature) => feature.ref === 'orch')?.tasks).toEqual([
      {
        ref: 'orch/task-155-example',
        title: 'Spec Title',
        status: 'claimed',
        task_type: 'implementation',
      },
    ]);
  });

  it('syncs review_level from task spec frontmatter', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'todo',
      title: 'Review Level Task',
      review_level: 'light',
    });
    writeBacklog(dir, { version: '1', features: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(readBacklog(dir).features[0].tasks[0].review_level).toBe('light');
  });

  it('defaults review_level to undefined when absent from frontmatter', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'todo',
      title: 'No Review Level',
    });
    writeBacklog(dir, { version: '1', features: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(readBacklog(dir).features[0].tasks[0].review_level).toBeUndefined();
  });

  it('updates review_level on an existing task when spec changes it', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'todo',
      title: 'Review Level Task',
      review_level: 'light',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'orch',
        title: 'Orch',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Review Level Task',
          status: 'todo',
          task_type: 'implementation',
          review_level: 'full',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(readBacklog(dir).features[0].tasks[0].review_level).toBe('light');
  });

  it('clears review_level on an existing task when spec removes it', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      feature: 'orch',
      status: 'todo',
      title: 'Review Level Task',
    });
    writeBacklog(dir, {
      version: '1',
      features: [{
        ref: 'orch',
        title: 'Orch',
        tasks: [{
          ref: 'orch/task-155-example',
          title: 'Review Level Task',
          status: 'todo',
          task_type: 'implementation',
          review_level: 'full',
        }],
      }],
    });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(readBacklog(dir).features[0].tasks[0].review_level).toBeUndefined();
  });

  it('treats a missing backlog directory as an empty authoritative set', async () => {
    rmSync(join(dir, 'backlog'), { recursive: true, force: true });
    writeBacklog(dir, { version: '1', features: [] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'backlog'));

    expect(result).toEqual({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_features: 0,
    });
  });

  it('runs backlog sync during coordinator startup before the first tick loop', async () => {
    process.env.ORCH_STATE_DIR = join(dir, '.orc-state');
    process.env.ORC_REPO_ROOT = dir;

    writeBacklog(dir, { version: '1', features: [] });
    writeFileSync(join(dir, '.orc-state', 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
    writeFileSync(join(dir, '.orc-state', 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
    writeFileSync(join(dir, '.orc-state', 'events.jsonl'), '');

    const syncBacklogFromSpecs = vi.fn().mockReturnValue({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_features: 0,
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit unexpectedly called with "${code}"`);
    });

    vi.doMock('./backlogSync.ts', () => ({ syncBacklogFromSpecs }));

    const { main, doShutdown } = await import('../coordinator.ts');
    await main();

    expect(syncBacklogFromSpecs).toHaveBeenCalledWith(
      join(dir, '.orc-state'),
      join(dir, 'backlog'),
    );

    await expect(doShutdown()).rejects.toThrow('process.exit unexpectedly called with "0"');
    exitSpy.mockRestore();
  });
});
