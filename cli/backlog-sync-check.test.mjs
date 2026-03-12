import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateBacklogSync } from './backlog-sync-check.ts';

let dir;

function writeSpec(baseDir, name, ref) {
  const frontmatter = ref ? `---\nref: ${ref}\nfeature: orch\nstatus: todo\n---\n\n` : '';
  writeFileSync(join(baseDir, 'docs', 'backlog', name), `${frontmatter}# Task X — Example\n`);
}

function writeState(baseDir, refs) {
  writeFileSync(
    join(baseDir, 'orc-state', 'backlog.json'),
    JSON.stringify({
      version: '1',
      epics: [
        {
          ref: 'orch',
          title: 'Orchestrator',
          tasks: refs.map((ref) => ({ ref, title: ref, status: 'todo' })),
        },
      ],
    }, null, 2),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backlog-sync-check-'));
  mkdirSync(join(dir, 'docs', 'backlog'), { recursive: true });
  mkdirSync(join(dir, 'orc-state'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateBacklogSync', () => {
  it('passes when every frontmatter-backed backlog spec ref exists in orchestrator state', () => {
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeSpec(dir, '131-example.md', 'orch/task-131-example');
    writeState(dir, ['orch/task-130-example', 'orch/task-131-example']);

    expect(validateBacklogSync(join(dir, 'docs', 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 2,
      missing: [],
    });
  });

  it('fails with missing refs and source files when a frontmatter-backed spec is unsynced', () => {
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeSpec(dir, '131-example.md', 'orch/task-131-example');
    writeState(dir, ['orch/task-130-example']);

    expect(validateBacklogSync(join(dir, 'docs', 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: false,
      spec_count: 2,
      missing: [{ file: '131-example.md', ref: 'orch/task-131-example' }],
    });
  });

  it('ignores legacy backlog docs that do not have frontmatter refs', () => {
    writeSpec(dir, '002-legacy.md');
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeState(dir, ['orch/task-130-example']);

    expect(validateBacklogSync(join(dir, 'docs', 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 1,
      missing: [],
    });
  });

  it('discovers specs in subdirectories (legacy/ and feature folders)', () => {
    mkdirSync(join(dir, 'docs', 'backlog', 'legacy'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'backlog', 'FEAT-001-worker-pool'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'backlog', 'legacy', '130-example.md'),
      '---\nref: orch/task-130-example\nfeature: orch\nstatus: done\n---\n\n# Task 130 — Example\n');
    writeFileSync(join(dir, 'docs', 'backlog', 'FEAT-001-worker-pool', '160.md'),
      '---\nref: orch/160\nfeature: worker-pool\nstatus: todo\n---\n\n# Task 160 — New task\n');
    writeState(dir, ['orch/task-130-example', 'orch/160']);

    expect(validateBacklogSync(join(dir, 'docs', 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 2,
      missing: [],
    });
  });

  it('ignores feat.md and other non-numeric files in feature folders', () => {
    mkdirSync(join(dir, 'docs', 'backlog', 'FEAT-001-worker-pool'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'backlog', 'FEAT-001-worker-pool', 'feat.md'),
      '# Worker Pool feature description\n');
    writeSpec(dir, '130-example.md', 'orch/task-130-example');
    writeState(dir, ['orch/task-130-example']);

    expect(validateBacklogSync(join(dir, 'docs', 'backlog'), join(dir, 'orc-state', 'backlog.json'))).toEqual({
      ok: true,
      spec_count: 1,
      missing: [],
    });
  });
});
