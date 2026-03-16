import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

function writeSpec(baseDir: string, name: string, { ref, epic, status, title = 'Example Title' }: { ref?: string; epic?: string; status?: string; title?: string } = {}) {
  const frontmatter = [
    '---',
    ...(ref ? [`ref: ${ref}`] : []),
    ...(epic ? [`epic: ${epic}`] : []),
    ...(status ? [`status: ${status}`] : []),
    '---',
    '',
  ].join('\n');
  writeFileSync(join(baseDir, 'docs', 'backlog', name), `${frontmatter}# Task 999 — ${title}\n`);
}

function writeBacklog(baseDir: string, backlog: unknown) {
  writeFileSync(join(baseDir, '.orc-state', 'backlog.json'), JSON.stringify(backlog, null, 2));
}

function readBacklog(baseDir: string): { epics: Array<{ ref: string; tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(baseDir, '.orc-state', 'backlog.json'), 'utf8'));
}

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'backlog-sync-'));
  mkdirSync(join(dir, 'docs', 'backlog'), { recursive: true });
  mkdirSync(join(dir, '.orc-state'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
  delete process.env.ORC_REPO_ROOT;
});

describe('syncBacklogFromSpecs', () => {
  it('adds a missing task from a spec file with status todo', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      epic: 'orch',
      status: 'todo',
      title: 'Rebuild Backlog',
    });
    writeBacklog(dir, { version: '1', epics: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 1,
      updated_tasks: 0,
      added_epics: 0,
    });
    expect(readBacklog(dir).epics[0].tasks).toEqual([
      {
        ref: 'orch/task-155-example',
        title: 'Rebuild Backlog',
        status: 'todo',
        task_type: 'implementation',
      },
    ]);
  });

  it('adds a missing epic when a spec references an unknown epic', async () => {
    writeSpec(dir, '200-other.md', {
      ref: 'other/task-200-example',
      epic: 'other',
      status: 'done',
      title: 'Other Work',
    });
    writeBacklog(dir, { version: '1', epics: [] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));
    const backlog = readBacklog(dir);

    expect(result.added_epics).toBe(1);
    expect(backlog.epics).toEqual([
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

  it('does not modify a task already in a claimed or in_progress status', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      epic: 'orch',
      status: 'done',
      title: 'Spec Wants Done',
    });
    writeBacklog(dir, {
      version: '1',
      epics: [{
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
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));
    const backlog = readBacklog(dir);

    expect(result.updated).toBe(false);
    expect(backlog.epics[0].tasks[0]).toEqual({
      ref: 'orch/task-155-example',
      title: 'Original Title',
      status: 'in_progress',
      task_type: 'implementation',
    });
  });

  it('updates an existing todo task to match the spec status', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      epic: 'orch',
      status: 'done',
      title: 'Spec Wants Done',
    });
    writeBacklog(dir, {
      version: '1',
      epics: [{
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
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 0,
      updated_tasks: 1,
      added_epics: 0,
    });
    expect(readBacklog(dir).epics[0].tasks[0].status).toBe('done');
  });

  it('updates a blocked task to match the spec status', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      epic: 'orch',
      status: 'done',
      title: 'Spec Wants Done',
    });
    writeBacklog(dir, {
      version: '1',
      epics: [{
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
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));

    expect(result).toEqual({
      updated: true,
      added_tasks: 0,
      updated_tasks: 1,
      added_epics: 0,
    });
    expect(readBacklog(dir).epics[0].tasks[0].status).toBe('done');
  });

  it('is idempotent when called twice with the same specs', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      epic: 'orch',
      status: 'todo',
      title: 'Same Result',
    });
    writeBacklog(dir, { version: '1', epics: [{ ref: 'orch', title: 'Orch', tasks: [] }] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const first = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));
    const snapshot = readFileSync(join(dir, '.orc-state', 'backlog.json'), 'utf8');
    const second = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));

    expect(first.updated).toBe(true);
    expect(second).toEqual({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_epics: 0,
    });
    expect(readFileSync(join(dir, '.orc-state', 'backlog.json'), 'utf8')).toBe(snapshot);
  });

  it('skips spec files without ref, epic, or status fields', async () => {
    writeSpec(dir, '155-missing-ref.md', { epic: 'orch', status: 'todo' });
    writeSpec(dir, '156-missing-epic.md', { ref: 'orch/task-156-example', status: 'todo' });
    writeSpec(dir, '157-missing-status.md', { ref: 'orch/task-157-example', epic: 'orch' });
    writeSpec(dir, '158-invalid-status.md', { ref: 'orch/task-158-example', epic: 'orch', status: 'unknown' });
    writeBacklog(dir, { version: '1', epics: [] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));

    expect(result).toEqual({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_epics: 0,
    });
    expect(readBacklog(dir)).toEqual({ version: '1', epics: [] });
  });

  it('does not import body lines that only look like frontmatter keys', async () => {
    writeFileSync(
      join(dir, 'docs', 'backlog', '159-body-keys.md'),
      [
        '---',
        'epic: orch',
        '---',
        '',
        '# Task 159 — Body Keys',
        '',
        'ref: orch/task-159-body-keys',
        'status: done',
      ].join('\n'),
    );
    writeBacklog(dir, { version: '1', epics: [] });

    const { syncBacklogFromSpecs } = await import('./backlogSync.ts');
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));

    expect(result.updated).toBe(false);
    expect(readBacklog(dir)).toEqual({ version: '1', epics: [] });
  });

  it('moves a non-active task under the epic declared by the spec', async () => {
    writeSpec(dir, '155-example.md', {
      ref: 'orch/task-155-example',
      epic: 'orch',
      status: 'done',
      title: 'Spec Wants Orch',
    });
    writeBacklog(dir, {
      version: '1',
      epics: [{
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
    const result = syncBacklogFromSpecs(join(dir, '.orc-state'), join(dir, 'docs', 'backlog'));
    const backlog = readBacklog(dir);

    expect(result.updated).toBe(true);
    expect(backlog.epics.find((epic) => epic.ref === 'wrong')?.tasks ?? []).toEqual([]);
    expect(backlog.epics.find((epic) => epic.ref === 'orch')?.tasks).toEqual([
      {
        ref: 'orch/task-155-example',
        title: 'Original Title',
        status: 'done',
        task_type: 'implementation',
      },
    ]);
  });

  it('runs backlog sync during coordinator startup before the first tick loop', async () => {
    process.env.ORCH_STATE_DIR = join(dir, '.orc-state');
    process.env.ORC_REPO_ROOT = dir;

    writeBacklog(dir, { version: '1', epics: [] });
    writeFileSync(join(dir, '.orc-state', 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
    writeFileSync(join(dir, '.orc-state', 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
    writeFileSync(join(dir, '.orc-state', 'events.jsonl'), '');

    const syncBacklogFromSpecs = vi.fn().mockReturnValue({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_epics: 0,
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
