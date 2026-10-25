import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacySiblingTarget, resolveOrchestrationRoot, resolveRepoRoot } from './repoRoot.ts';

const CONFIG = 'orc-state.config.json';

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function initRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

describe('repoRoot', () => {
  let tmp: string;

  beforeEach(() => {
    // realpathSync: macOS tmpdir is a symlink (/var → /private/var); git
    // reports resolved paths, so compare against the resolved fixture path.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'repo-root-test-')));
    vi.stubEnv('ORC_HOME', undefined as unknown as string);
    vi.stubEnv('ORC_REPO_ROOT', undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('resolveOrchestrationRoot', () => {
    it('ORC_HOME wins over a config file in the cwd ancestry', () => {
      const home = join(tmp, 'orch-home');
      const other = join(tmp, 'other');
      mkdirSync(home, { recursive: true });
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, CONFIG), '{}');
      vi.stubEnv('ORC_HOME', home);

      expect(resolveOrchestrationRoot(other)).toBe(home);
    });

    it('ORC_HOME wins over ORC_REPO_ROOT when both are set', () => {
      const home = join(tmp, 'orch-home');
      const forced = join(tmp, 'forced-root');
      mkdirSync(home, { recursive: true });
      mkdirSync(forced, { recursive: true });
      vi.stubEnv('ORC_HOME', home);
      vi.stubEnv('ORC_REPO_ROOT', forced);

      expect(resolveOrchestrationRoot(tmp)).toBe(home);
    });

    it('ORC_REPO_ROOT keeps precedence over walk-up discovery', () => {
      const forced = join(tmp, 'forced-root');
      const nested = join(tmp, 'project', 'src');
      mkdirSync(forced, { recursive: true });
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(tmp, 'project', CONFIG), '{}');
      vi.stubEnv('ORC_REPO_ROOT', forced);

      expect(resolveOrchestrationRoot(nested)).toBe(forced);
    });

    it('walks up from a nested directory to the config-bearing directory', () => {
      const root = join(tmp, 'project');
      const nested = join(root, 'a', 'b', 'c');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, CONFIG), '{}');

      expect(resolveOrchestrationRoot(nested)).toBe(root);
    });

    it('normalizes a walk-up hit inside a git worktree to the main checkout', () => {
      // Attached layout: config is checked in, so a worker cwd inside
      // .worktrees/<run>/ finds the worktree's own config copy first.
      const repo = join(tmp, 'attached-repo');
      mkdirSync(repo, { recursive: true });
      initRepo(repo);
      writeFileSync(join(repo, CONFIG), '{}');
      git(repo, 'add', CONFIG);
      git(repo, 'commit', '-m', 'add config');
      const worktree = join(repo, '.worktrees', 'run-1');
      git(repo, 'worktree', 'add', worktree, '-b', 'test-branch');

      expect(resolveOrchestrationRoot(worktree)).toBe(repo);
    });

    it('escapes a config-free target-repo worktree up to the orchestration root', () => {
      // Sibling layout: the target repo carries no config, so the walk-up
      // passes through the worktree and lands on the orchestration root.
      const orch = join(tmp, 'orch');
      const target = join(tmp, 'product');
      mkdirSync(orch, { recursive: true });
      mkdirSync(target, { recursive: true });
      writeFileSync(join(orch, CONFIG), '{}');
      initRepo(target);
      writeFileSync(join(target, 'code.txt'), 'product');
      git(target, 'add', 'code.txt');
      git(target, 'commit', '-m', 'product code');
      const worktree = join(orch, '.worktrees', 'run-1');
      mkdirSync(join(orch, '.worktrees'), { recursive: true });
      git(target, 'worktree', 'add', worktree, '-b', 'run-branch');

      expect(resolveOrchestrationRoot(worktree)).toBe(orch);
    });

    it('falls back to git-based resolution when no config is found', () => {
      const repo = join(tmp, 'plain-repo');
      const nested = join(repo, 'src');
      mkdirSync(nested, { recursive: true });
      initRepo(repo);

      expect(resolveOrchestrationRoot(nested)).toBe(resolveRepoRoot(nested));
      expect(resolveOrchestrationRoot(nested)).toBe(repo);
    });
  });

  describe('legacySiblingTarget', () => {
    it('is null when no config file exists or target_repo is absent', () => {
      expect(legacySiblingTarget(join(tmp, CONFIG), tmp)).toBeNull();
      writeFileSync(join(tmp, CONFIG), JSON.stringify({ default_provider: 'claude' }));
      expect(legacySiblingTarget(join(tmp, CONFIG), tmp)).toBeNull();
    });

    it('names a target_repo that resolves to a different directory, relative to the config file', () => {
      const orch = join(tmp, 'orch');
      mkdirSync(orch, { recursive: true });
      writeFileSync(join(orch, CONFIG), JSON.stringify({ target_repo: '../product' }));
      expect(legacySiblingTarget(join(orch, CONFIG), orch)).toBe(join(tmp, 'product'));
    });

    it('is null when target_repo is the orchestration root itself, malformed, or not a string', () => {
      writeFileSync(join(tmp, CONFIG), JSON.stringify({ target_repo: '.' }));
      expect(legacySiblingTarget(join(tmp, CONFIG), tmp)).toBeNull();
      writeFileSync(join(tmp, CONFIG), 'NOT-JSON');
      expect(legacySiblingTarget(join(tmp, CONFIG), tmp)).toBeNull();
      writeFileSync(join(tmp, CONFIG), JSON.stringify({ target_repo: 42 }));
      expect(legacySiblingTarget(join(tmp, CONFIG), tmp)).toBeNull();
    });

    it('depends only on config, never on ORC_REPO_ROOT', () => {
      const orch = join(tmp, 'orch');
      mkdirSync(orch, { recursive: true });
      writeFileSync(join(orch, CONFIG), JSON.stringify({ target_repo: '../product' }));
      vi.stubEnv('ORC_REPO_ROOT', join(tmp, 'forced'));
      expect(legacySiblingTarget(join(orch, CONFIG), orch)).toBe(join(tmp, 'product'));
    });
  });
});
