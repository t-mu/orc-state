import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSiblingLayout } from './siblingLayoutCheck.ts';

let tmp: string;
let target: string;
let stateDir: string;

function gitInit(dir: string): void {
  const r = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sibling-check-test-')));
  target = join(tmp, 'target');
  stateDir = join(tmp, 'orch', '.orc-state');
  mkdirSync(target, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  gitInit(target);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('checkSiblingLayout', () => {
  it('is skipped in the attached layout', () => {
    const result = checkSiblingLayout({ isSibling: false, targetRepoRoot: target, stateDir });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('passes when target is a git repo and the state dir is writable', () => {
    const result = checkSiblingLayout({ isSibling: true, targetRepoRoot: target, stateDir });
    expect(result).toMatchObject({ ok: true, skipped: false, errors: [], warnings: [] });
  });

  it('errors when target_repo does not exist', () => {
    const result = checkSiblingLayout({ isSibling: true, targetRepoRoot: join(tmp, 'nope'), stateDir });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('does not exist'))).toBe(true);
  });

  it('errors when target_repo is not a git repository', () => {
    const notGit = join(tmp, 'plain');
    mkdirSync(notGit, { recursive: true });
    const result = checkSiblingLayout({ isSibling: true, targetRepoRoot: notGit, stateDir });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('not a git repository'))).toBe(true);
  });

  it('errors when the state dir does not exist', () => {
    const result = checkSiblingLayout({ isSibling: true, targetRepoRoot: target, stateDir: join(tmp, 'missing-state') });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('state dir does not exist'))).toBe(true);
  });

  it('warns (non-fatal) when framework artifacts leak into the target repo', () => {
    mkdirSync(join(target, '.orc-state'), { recursive: true });
    writeFileSync(join(target, 'orc-state.config.json'), '{}');
    const result = checkSiblingLayout({ isSibling: true, targetRepoRoot: target, stateDir });
    // Warnings do not fail the check.
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('.orc-state'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('orc-state.config.json'))).toBe(true);
  });
});
