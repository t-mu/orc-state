import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProjectLayout } from './projectLayoutCheck.ts';

let tmp: string;
let target: string;
let stateDir: string;

function gitInit(dir: string): void {
  const r = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'project-layout-test-')));
  target = join(tmp, 'target');
  stateDir = join(tmp, 'orch', '.orc-state');
  mkdirSync(target, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  gitInit(target);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('checkProjectLayout', () => {
  it('passes when target is a git repo and the state dir is writable', () => {
    const result = checkProjectLayout({ targetRepoRoot: target, stateDir });
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('errors when target_repo does not exist', () => {
    const result = checkProjectLayout({ targetRepoRoot: join(tmp, 'nope'), stateDir });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('target repository does not exist'))).toBe(true);
  });

  it('errors when target_repo is not a git repository', () => {
    const notGit = join(tmp, 'plain');
    mkdirSync(notGit, { recursive: true });
    const result = checkProjectLayout({ targetRepoRoot: notGit, stateDir });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('not a git repository'))).toBe(true);
  });

  it('errors when the state dir does not exist', () => {
    const result = checkProjectLayout({ targetRepoRoot: target, stateDir: join(tmp, 'missing-state') });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('state dir does not exist'))).toBe(true);
  });

  it('warns (non-fatal) when framework artifacts leak into the target repo', () => {
    mkdirSync(join(target, '.orc-state'), { recursive: true });
    writeFileSync(join(target, 'orc-state.config.json'), '{}');
    const result = checkProjectLayout({ targetRepoRoot: target, stateDir });
    // Warnings do not fail the check.
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('.orc-state'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('orc-state.config.json'))).toBe(true);
  });

  it('errors when run worktrees would land inside the target working tree', () => {
    const result = checkProjectLayout({ targetRepoRoot: target, stateDir, worktreesDir: join(target, '.worktrees') });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('inside the target working tree'))).toBe(true);
    expect(checkProjectLayout({ targetRepoRoot: target, stateDir, worktreesDir: join(stateDir, 'worktrees') }).ok).toBe(true);
  });

  it('errors when the data home is not writable', () => {
    const dataHome = join(tmp, 'data');
    mkdirSync(dataHome, { mode: 0o500 });
    try {
      const result = checkProjectLayout({ targetRepoRoot: target, stateDir, dataHome });
      // Root can write anywhere; the check only applies to ordinary users.
      if (process.getuid?.() !== 0) expect(result.errors).toContain(`data home is not writable: ${dataHome}`);
    } finally {
      chmodSync(dataHome, 0o700);
    }
  });
});
