import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  it('is a no-op in the attached layout (orchestration root == target repo root)', () => {
    const docsDir = join(root, 'backlog');
    const specPath = writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot: root,
      targetRepoRoot: root,
    });

    expect(result).toEqual({ written: false, committed: false });
    expect(readFileSync(specPath, 'utf8')).toContain('status: todo');
  });

  it('writes status: done into the spec frontmatter in the sibling layout (non-git orchestration root)', () => {
    const orchestrationRoot = join(root, 'orch');
    const target = join(root, 'target');
    const docsDir = join(orchestrationRoot, 'backlog');
    const specPath = writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      targetRepoRoot: target,
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
    const target = join(root, 'target');
    mkdirSync(orchestrationRoot, { recursive: true });
    initGitRepo(orchestrationRoot);
    const docsDir = join(orchestrationRoot, 'backlog');
    writeSpec(docsDir, '187-example.md', 'sibling/187-example');

    const result = writeSpecStatusDone('sibling/187-example', {
      docsDir,
      orchestrationRoot,
      targetRepoRoot: target,
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
      targetRepoRoot: join(root, 'target'),
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
      targetRepoRoot: join(root, 'target'),
    });

    expect(result).toEqual({ written: false, committed: false });
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
      targetRepoRoot: join(root, 'target'),
    });

    // Next sync tick must NOT revert the runtime task back to the old spec status.
    const syncResult = syncBacklogFromSpecs(stateDir, docsDir);
    expect(syncResult.updated).toBe(false);
    const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8'));
    expect(backlog.features[0].tasks[0].status).toBe('done');
  });
});
