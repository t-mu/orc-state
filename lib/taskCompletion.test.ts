import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSpecStatusDone } from './taskCompletion.ts';
import { syncBacklogFromSpecs } from './backlogSync.ts';
import { atomicWriteJson } from './atomicWrite.ts';

let root: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initGitRepo(dir: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

const SPEC = (ref: string, status = 'todo') =>
  `---\nref: ${ref}\nfeature: sibling\nstatus: ${status}\nreview_level: full\n---\n\n# Task 187 — Example\n\nStatus notes: the word status: appears in the body and must be untouched.\n`;

function writeSpec(docsDir: string, file: string, ref: string, status = 'todo'): string {
  mkdirSync(docsDir, { recursive: true });
  const path = join(docsDir, file);
  writeFileSync(path, SPEC(ref, status));
  return path;
}

beforeEach(() => {
  // realpathSync: macOS tmpdir is a symlink; git reports resolved paths.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'task-completion-test-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeSpecStatusDone', () => {
  it('is a no-op in the attached layout (isSibling false)', () => {
    const docsDir = join(root, 'backlog');
    const specPath = writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot: root,
      isSibling: false,
    });

    expect(result).toEqual({ written: false, committed: false });
    expect(readFileSync(specPath, 'utf8')).toContain('status: todo');
  });

  it('is a no-op when isSibling is false even if roots differ (e.g. ORC_REPO_ROOT-forced target)', () => {
    // Regression: detection is config-driven, not root-equality. A shell with
    // ambient ORC_REPO_ROOT collapses the roots; isSibling=false must still gate.
    const docsDir = join(root, 'backlog');
    const specPath = writeSpec(docsDir, '187-example.md', 'sibling/187-example');
    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot: root,
      isSibling: false,
    });
    expect(result).toEqual({ written: false, committed: false });
    expect(readFileSync(specPath, 'utf8')).toContain('status: todo');
  });

  it('default gate writes back in a real sibling config even with ambient ORC_REPO_ROOT set', async () => {
    // Regression for BUG 2: the DEFAULT gate resolves `isSibling` from the
    // config-driven IS_SIBLING_LAYOUT, not root-equality. A worker/operator
    // shell carries ambient ORC_REPO_ROOT (= orch root), which collapses
    // TARGET_REPO_ROOT onto ORCHESTRATION_ROOT — the OLD `orchestrationRoot ===
    // targetRepoRoot` gate would no-op here. The config (target_repo set) must
    // still drive detection so the writeback fires.
    const orch = join(root, 'orch');
    mkdirSync(join(orch, '.orc-state'), { recursive: true });
    writeFileSync(join(orch, 'orc-state.config.json'), JSON.stringify({ target_repo: '../target' }));
    const docsDir = join(orch, 'backlog');
    const specPath = writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const saved = {
      ORC_STATE_DIR: process.env.ORC_STATE_DIR,
      ORC_REPO_ROOT: process.env.ORC_REPO_ROOT,
      ORC_HOME: process.env.ORC_HOME,
    };
    process.env.ORC_STATE_DIR = join(orch, '.orc-state'); // → ORCHESTRATION_ROOT = orch
    process.env.ORC_REPO_ROOT = orch; // ambient: collapses roots under the OLD gate
    delete process.env.ORC_HOME;
    vi.resetModules();
    try {
      const { writeSpecStatusDone } = await import('./taskCompletion.ts');
      // No options → default docsDir/orchestrationRoot/isSibling from paths.ts.
      const result = writeSpecStatusDone('sibling/187-example');
      expect(result.written).toBe(true);
      expect(readFileSync(specPath, 'utf8')).toContain('status: done');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  });

  it('writes status: done into the spec frontmatter in the sibling layout (non-git orchestration root)', () => {
    const orchestrationRoot = join(root, 'orch');
    const docsDir = join(orchestrationRoot, 'backlog');
    const specPath = writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      isSibling: true,
    });

    // Non-git orchestration root: file written, commit gracefully skipped.
    expect(result).toEqual({ written: true, committed: false });
    const text = readFileSync(specPath, 'utf8');
    expect(text).toContain('status: done');
    expect(text).not.toContain('status: todo');
    // Only frontmatter status changed — the body "status:" mention is untouched.
    expect(text).toContain('Status notes: the word status: appears in the body');
    expect(text).toContain('# Task 187 — Example');
  });

  it('commits the spec in the orchestration repo when it is a git repository', () => {
    const orchestrationRoot = join(root, 'orch');
    mkdirSync(orchestrationRoot, { recursive: true });
    initGitRepo(orchestrationRoot);
    const docsDir = join(orchestrationRoot, 'backlog');
    writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      isSibling: true,
    });

    expect(result).toEqual({ written: true, committed: true });
    // The commit exists with the expected message and contains the spec.
    expect(git(orchestrationRoot, 'log', '--oneline')).toContain('chore(backlog): sibling/187-example done');
    const showed = git(orchestrationRoot, 'show', '--stat', 'HEAD');
    expect(showed).toContain('backlog/187-example.md');
    // The spec is committed (working tree clean for that path).
    expect(git(orchestrationRoot, 'status', '--porcelain', 'backlog/187-example.md')).toBe('');
  });

  it('returns a no-op when the task spec is not found', () => {
    const orchestrationRoot = join(root, 'orch');
    const docsDir = join(orchestrationRoot, 'backlog');
    writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const result = writeSpecStatusDone('sibling/999-missing', {
      docsDir,
      orchestrationRoot,
      isSibling: true,
    });

    expect(result).toEqual({ written: false, committed: false });
  });

  it('is idempotent when the spec is already done', () => {
    const orchestrationRoot = join(root, 'orch');
    const docsDir = join(orchestrationRoot, 'backlog');
    writeSpec(docsDir, '187-example.md', 'sibling/187-example', 'done');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      isSibling: true,
    });

    expect(result).toEqual({ written: false, committed: false });
  });

  it('rewrites only the status token, leaving the rest of the spec intact', () => {
    const orchestrationRoot = join(root, 'orch');
    const docsDir = join(orchestrationRoot, 'backlog');
    const specPath = writeSpec(docsDir, '187-example.md', 'sibling/187-example');
    const original = readFileSync(specPath, 'utf8');

    writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      isSibling: true,
    });

    // Exactly one substitution: `status: todo` → `status: done`; nothing else.
    expect(readFileSync(specPath, 'utf8')).toBe(original.replace('status: todo', 'status: done'));
  });

  it('commits only the spec, not unrelated staged changes', () => {
    const orchestrationRoot = join(root, 'orch');
    mkdirSync(orchestrationRoot, { recursive: true });
    initGitRepo(orchestrationRoot);
    const docsDir = join(orchestrationRoot, 'backlog');
    writeSpec(docsDir, '187-example.md', 'sibling/187-example');
    // An unrelated, staged change that must NOT be swept into the chore commit.
    writeFileSync(join(orchestrationRoot, 'unrelated.txt'), 'staged but unrelated\n');
    git(orchestrationRoot, 'add', 'unrelated.txt');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      isSibling: true,
    });

    expect(result).toEqual({ written: true, committed: true });
    // The commit contains only the spec file.
    const files = git(orchestrationRoot, 'show', '--name-only', '--format=', 'HEAD').trim();
    expect(files).toBe('backlog/187-example.md');
    // The unrelated file remains staged/uncommitted.
    expect(git(orchestrationRoot, 'status', '--porcelain', 'unrelated.txt')).toContain('unrelated.txt');
  });

  it('backlog sync converges (does not revert) after writeback', () => {
    const orchestrationRoot = join(root, 'orch');
    const stateDir = join(root, 'state');
    const docsDir = join(orchestrationRoot, 'backlog');
    mkdirSync(stateDir, { recursive: true });
    writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    // Runtime state: the coordinator already marked the task done (runtime-only).
    atomicWriteJson(join(stateDir, 'backlog.json'), {
      version: '1',
      features: [{
        ref: 'sibling',
        title: 'Sibling',
        tasks: [{ ref: 'sibling/187-example', title: 'Example', status: 'done', task_type: 'implementation', review_level: 'full' }],
      }],
    });

    // Writeback brings the spec to done, matching runtime.
    writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      isSibling: true,
    });

    // Next sync tick must NOT revert the runtime task back to the old spec status.
    const syncResult = syncBacklogFromSpecs(stateDir, docsDir);
    expect(syncResult.updated).toBe(false);
    const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8'));
    expect(backlog.features[0].tasks[0].status).toBe('done');
  });

  it('does NOT revert a done runtime task when the spec is left stale (terminal-status guard)', () => {
    // A merged task is done in runtime; if its spec still says todo (writeback
    // failed or has not landed), sync must NOT drag it back to todo — that would
    // re-dispatch already-completed work. The terminal-status guard in
    // backlogSync protects done/released runtime tasks from spec demotion, so
    // writeback is no longer load-bearing for lifecycle safety (only for the
    // audit trail).
    const orchestrationRoot = join(root, 'orch');
    const stateDir = join(root, 'state');
    const docsDir = join(orchestrationRoot, 'backlog');
    mkdirSync(stateDir, { recursive: true });
    writeSpec(docsDir, '187-example.md', 'sibling/187-example', 'todo'); // spec left stale

    atomicWriteJson(join(stateDir, 'backlog.json'), {
      version: '1',
      features: [{
        ref: 'sibling',
        title: 'Sibling',
        tasks: [{ ref: 'sibling/187-example', title: 'Example', status: 'done', task_type: 'implementation', review_level: 'full' }],
      }],
    });

    // No writeback — the exact state the guard must tolerate without reverting.
    syncBacklogFromSpecs(stateDir, docsDir);
    const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8'));
    expect(backlog.features[0].tasks[0].status).toBe('done');
  });
});
