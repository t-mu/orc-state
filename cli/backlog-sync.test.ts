import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatBacklogRepairResult } from './backlog-sync.ts';

describe('formatBacklogRepairResult', () => {
  it('reports a no-op repair cleanly', () => {
    expect(formatBacklogRepairResult({
      updated: false,
      added_tasks: 0,
      updated_tasks: 0,
      added_features: 0,
    })).toBe('backlog sync OK: state already matched the spec definitions');
  });

  it('reports repaired task and feature counts', () => {
    expect(formatBacklogRepairResult({
      updated: true,
      added_tasks: 2,
      updated_tasks: 3,
      added_features: 1,
    })).toBe([
      'backlog sync repaired orchestrator state',
      '- added features: 1',
      '- added tasks: 2',
      '- updated tasks: 3',
    ].join('\n'));
  });
});

describe('the Markdown sync commands in a registered project', () => {
  it('exit 1 with a pointer to the project commands instead of reporting OK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-backlog-sync-project-'));
    try {
      writeFileSync(join(dir, 'runtime.db'), '');
      writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
      for (const script of ['cli/backlog-sync.ts', 'cli/backlog-sync-check.ts', 'cli/backlog-orient.ts']) {
        const result = spawnSync('node', [script], {
          cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8',
          env: { ...process.env, ORC_STATE_DIR: dir, ORC_PROJECT_ID: '', ORC_BACKLOG_DIR: join(dir, 'backlog') },
        });
        expect(result.status, script).toBe(1);
        expect(result.stderr).toContain('is legacy-only');
        expect(result.stdout).not.toContain('OK');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
