import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-feature-create-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/feature-create.ts', () => {
  it('creates a new feature in the backlog', () => {
    const result = runCli(['my-feature', '--title=My Feature']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('feature created: my-feature');
    const backlog = readBacklog();
    const feature = backlog.features.find((f: Record<string, unknown>) => f.ref === 'my-feature');
    expect(feature).toBeDefined();
    expect(feature?.title).toBe('My Feature');
  });

  it('auto-generates title from ref when --title is not provided', () => {
    const result = runCli(['new-thing']);
    expect(result.status).toBe(0);
    const backlog = readBacklog();
    const feature = backlog.features.find((f: Record<string, unknown>) => f.ref === 'new-thing');
    expect(feature?.title).toBe('New Thing');
  });

  it('exits 1 when ref is not provided', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc feature-create');
  });

  it('exits 1 when ref has invalid format', () => {
    const result = runCli(['INVALID_REF']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid feature ref');
  });

  it('exits 1 when feature already exists', () => {
    runCli(['my-feature', '--title=First']);
    const result = runCli(['my-feature', '--title=Second']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('feature already exists');
  });

  it('creates feature with empty tasks array', () => {
    runCli(['empty-feature']);
    const backlog = readBacklog();
    const feature = backlog.features.find((f: Record<string, unknown>) => f.ref === 'empty-feature');
    expect(Array.isArray(feature?.tasks)).toBe(true);
    expect((feature?.tasks as unknown[]).length).toBe(0);
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/feature-create.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readBacklog(): { features: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')) as { features: Array<Record<string, unknown>> };
}
