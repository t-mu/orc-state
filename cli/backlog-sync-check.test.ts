import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTaskSpecRefs, validateBacklogSync } from './backlog-sync-check.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

function writeSpec(baseDir: string, name: string, ref?: string) {
  const frontmatter = ref ? `---\nref: ${ref}\nfeature: orch\nstatus: todo\n---\n\n` : '';
  const taskNumber = /^\d+/.exec(name)?.[0] ?? '999';
  writeFileSync(join(baseDir, 'backlog', name), `${frontmatter}# Task ${taskNumber} — Example\n`);
}

function writeState(baseDir: string, refs: string[]) {
  writeFileSync(
    join(baseDir, 'orc-state', 'backlog.json'),
    JSON.stringify({
      version: '1',
      features: [
        {
          ref: 'orch',
          title: 'Orchestrator',
          tasks: refs.map((ref) => ({ ref, title: 'Example', status: 'todo' })),
        },
      ],
    }, null, 2),
  );
}

beforeEach(() => {
  dir = createTempStateDir('backlog-sync-check-');
  mkdirSync(join(dir, 'backlog'), { recursive: true });
  mkdirSync(join(dir, 'orc-state'), { recursive: true });
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('validateBacklogSync', () => {
  it('passes when every frontmatter-backed backlog spec ref exists in orchestrator state', () => {
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeSpec(dir, '131-example.md', 'orch/task-131-example');
    writeState(dir, ['orch/task-130-example', 'orch/task-131-example']);

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 2,
      filtered: false,
      missing: [],
      mismatches: [],
    });
  });

  it('fails with missing refs and source files when a frontmatter-backed spec is unsynced', () => {
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeSpec(dir, '131-example.md', 'orch/task-131-example');
    writeState(dir, ['orch/task-130-example']);

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: false,
      spec_count: 2,
      filtered: false,
      missing: [{ file: '131-example.md', ref: 'orch/task-131-example' }],
      mismatches: [],
    });
  });

  it('ignores legacy backlog docs that do not have frontmatter refs', () => {
    writeSpec(dir, '002-legacy.md');
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeState(dir, ['orch/task-130-example']);

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 1,
      filtered: false,
      missing: [],
      mismatches: [],
    });
  });

  it('discovers specs in feature subdirectories but ignores legacy/', () => {
    mkdirSync(join(dir, 'backlog', 'legacy'), { recursive: true });
    mkdirSync(join(dir, 'backlog', 'FEAT-001-worker-pool'), { recursive: true });
    writeFileSync(join(dir, 'backlog', 'legacy', '130-example.md'),
      '---\nref: orch/task-130-example\nfeature: orch\nstatus: done\n---\n\n# Task 130 — Example\n');
    writeFileSync(join(dir, 'backlog', 'FEAT-001-worker-pool', '160.md'),
      '---\nref: orch/160\nfeature: worker-pool\nstatus: todo\n---\n\n# Task 160 — New task\n');
    writeFileSync(
      join(dir, 'orc-state', 'backlog.json'),
      JSON.stringify({
        version: '1',
        features: [
          {
            ref: 'worker-pool',
            title: 'Worker Pool',
            tasks: [{ ref: 'orch/160', title: 'New task', status: 'todo' }],
          },
        ],
      }, null, 2),
    );

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 1,
      filtered: false,
      missing: [],
      mismatches: [],
    });
  });

  it('extracts only active refs when legacy and feature subdirectories coexist', () => {
    mkdirSync(join(dir, 'backlog', 'legacy'), { recursive: true });
    mkdirSync(join(dir, 'backlog', 'feature-x'), { recursive: true });
    writeFileSync(join(dir, 'backlog', 'legacy', '130-example.md'),
      '---\nref: orch/task-130-example\nfeature: orch\nstatus: done\n---\n\n# Task 130 — Example\n');
    writeFileSync(join(dir, 'backlog', 'feature-x', '160.md'),
      '---\nref: orch/160\nfeature: worker-pool\nstatus: todo\n---\n\n# Task 160 — New task\n');

    expect(extractTaskSpecRefs(join(dir, 'backlog'))).toEqual([
      { file: 'feature-x/160.md', ref: 'orch/160' },
    ]);
  });

  it('ignores feat.md and other non-numeric files in feature folders', () => {
    mkdirSync(join(dir, 'backlog', 'FEAT-001-worker-pool'), { recursive: true });
    writeFileSync(join(dir, 'backlog', 'FEAT-001-worker-pool', 'feat.md'),
      '# Worker Pool feature description\n');
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeState(dir, ['orch/task-130-example']);

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 1,
      filtered: false,
      missing: [],
      mismatches: [],
    });
  });

  it('scopes validation to specified refs when filterRefs is provided', () => {
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeSpec(dir, '131-example.md', 'orch/task-131-example');
    // only register 130; 131 is missing from state
    writeState(dir, ['orch/task-130-example']);

    // without filter: fails because 131 is missing
    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toMatchObject({
      ok: false,
      spec_count: 2,
    });

    // with filter on 130 only: passes because 130 is registered
    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'), new Set(['orch/task-130-example']))).toEqual({
      ok: true,
      spec_count: 1,
      filtered: true,
      missing: [],
      mismatches: [],
    });
  });

  it('reports missing ref when filterRefs targets an unregistered ref', () => {
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeSpec(dir, '131-example.md', 'orch/task-131-example');
    writeState(dir, ['orch/task-130-example']);

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'), new Set(['orch/task-131-example']))).toEqual({
      ok: false,
      spec_count: 1,
      filtered: true,
      missing: [{ file: '131-example.md', ref: 'orch/task-131-example' }],
      mismatches: [],
    });
  });

  it('sets filtered: false when no filterRefs provided', () => {
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeState(dir, ['orch/task-130-example']);

    const result = validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'));
    expect(result.filtered).toBe(false);
  });

  it('reports metadata drift for feature, title, and inactive status', () => {
    writeFileSync(join(dir, 'backlog', '130-example.md'),
      '---\nref: orch/task-130-example\nfeature: orch\nstatus: done\n---\n\n# Task 130 — Expected Title\n');
    writeFileSync(
      join(dir, 'orc-state', 'backlog.json'),
      JSON.stringify({
        version: '1',
        features: [
          {
            ref: 'wrong',
            title: 'Wrong',
            tasks: [
              { ref: 'orch/task-130-example', title: 'Wrong Title', status: 'todo' },
            ],
          },
        ],
      }, null, 2),
    );

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: false,
      spec_count: 1,
      filtered: false,
      missing: [],
      mismatches: [
        {
          file: '130-example.md',
          ref: 'orch/task-130-example',
          field: 'feature',
          expected: 'orch',
          actual: 'wrong',
        },
        {
          file: '130-example.md',
          ref: 'orch/task-130-example',
          field: 'title',
          expected: 'Expected Title',
          actual: 'Wrong Title',
        },
        {
          file: '130-example.md',
          ref: 'orch/task-130-example',
          field: 'status',
          expected: 'done',
          actual: 'todo',
        },
      ],
    });
  });

  it('still reports active feature/title drift but ignores active status drift', () => {
    writeFileSync(join(dir, 'backlog', '130-example.md'),
      '---\nref: orch/task-130-example\nfeature: orch\nstatus: done\n---\n\n# Task 130 — Expected Title\n');
    writeFileSync(
      join(dir, 'orc-state', 'backlog.json'),
      JSON.stringify({
        version: '1',
        features: [
          {
            ref: 'wrong',
            title: 'Orchestrator',
            tasks: [
              { ref: 'orch/task-130-example', title: 'Wrong Title', status: 'in_progress' },
            ],
          },
        ],
      }, null, 2),
    );

    expect(validateBacklogSync(join(dir, 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: false,
      spec_count: 1,
      filtered: false,
      missing: [],
      mismatches: [
        {
          file: '130-example.md',
          ref: 'orch/task-130-example',
          field: 'feature',
          expected: 'orch',
          actual: 'wrong',
        },
        {
          file: '130-example.md',
          ref: 'orch/task-130-example',
          field: 'title',
          expected: 'Expected Title',
          actual: 'Wrong Title',
        },
      ],
    });
  });
});
