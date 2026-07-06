import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGitignore } from './gitignore.ts';

let repo: string;
let cwd: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gitignore-test-'));
  spawnSync('git', ['init'], { cwd: repo });
  cwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('ensureGitignore', () => {
  it('adds .orc-state/ to .gitignore in the attached layout', () => {
    ensureGitignore({ siblingLayout: false });
    const gitignore = join(repo, '.gitignore');
    expect(existsSync(gitignore)).toBe(true);
    expect(readFileSync(gitignore, 'utf8')).toContain('.orc-state/');
  });

  it('is idempotent — does not duplicate the entry', () => {
    ensureGitignore({ siblingLayout: false });
    ensureGitignore({ siblingLayout: false });
    const contents = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(contents.match(/\.orc-state\//g)?.length).toBe(1);
  });

  it('is a no-op in the sibling layout — never touches the repo .gitignore', () => {
    ensureGitignore({ siblingLayout: true });
    // No .gitignore created in the (would-be target) repo.
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });
});
