import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// End-to-end sibling-layout lifecycle: scaffold an orchestration home targeting
// a separate product repo via `orc init --sibling`, then drive one task run
// through worktree → product-only commit → merge → coordinator spec writeback,
// using the real runWorktree / backlogSync / taskCompletion functions against
// real git repos. Asserts the target repo receives only product code and the
// orchestration repo receives the status writeback commit.

const initScript = resolve(import.meta.dirname, '..', 'cli', 'init.ts');
const ORC_ENV_KEYS = [
  'ORC_STATE_DIR', 'ORC_REPO_ROOT', 'ORC_HOME',
  'ORC_BACKLOG_DIR', 'ORC_PLANS_DIR', 'ORC_WORKTREES_DIR', 'ORC_CONFIG_FILE',
];

const TASK_REF = 'sibling-demo/1-demo-feature';
const TASK_SPEC = `---
ref: ${TASK_REF}
feature: sibling-demo
status: todo
review_level: none
---

# Task 1 — Demo Feature

## Acceptance criteria
- [ ] Feature added.
`;

let tmp: string;
let orch: string;
let product: string;
let saved: Record<string, string | undefined>;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

beforeEach(() => {
  vi.resetModules();
  saved = Object.fromEntries(ORC_ENV_KEYS.map((k) => [k, process.env[k]]));

  // realpathSync: macOS tmpdir is a symlink; git reports resolved paths.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sibling-e2e-')));
  orch = join(tmp, 'orch');
  product = join(tmp, 'product');
  mkdirSync(orch, { recursive: true });

  // Product (target) repo: a real git repo with one product commit.
  mkdirSync(product, { recursive: true });
  initRepo(product);
  writeFileSync(join(product, 'product.txt'), 'product code\n');
  git(product, 'add', 'product.txt');
  git(product, 'commit', '-m', 'initial product commit');

  // Scaffold the orchestration home via the real `orc init --sibling`, with the
  // ambient ORC_* path overrides cleared so paths resolve under `orch`.
  const cleanEnv = { ...process.env };
  for (const k of ORC_ENV_KEYS) delete cleanEnv[k];
  const initResult = spawnSync(
    'node',
    [initScript, '--sibling=../product', '--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp'],
    { cwd: orch, env: cleanEnv, encoding: 'utf8' },
  );
  if (initResult.status !== 0) {
    throw new Error(`init --sibling failed: ${initResult.stderr}\n${initResult.stdout}`);
  }

  // In-process env for the lifecycle functions: point at the orchestration home;
  // clear ORC_REPO_ROOT so the configured target_repo drives target resolution.
  for (const k of ORC_ENV_KEYS) delete process.env[k];
  process.env.ORC_STATE_DIR = join(orch, '.orc-state');
});

afterEach(() => {
  for (const k of ORC_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('sibling-layout lifecycle e2e', () => {
  it('runs a task through worktree, product-only merge, and orchestration writeback', async () => {
    const stateDir = join(orch, '.orc-state');

    // init scaffolded the sibling layout.
    const config = JSON.parse(readFileSync(join(orch, 'orc-state.config.json'), 'utf8'));
    expect(config.target_repo).toBe('../product');

    // Author a task spec in the orchestration backlog and commit the home
    // baseline (as an operator would after `/spec`).
    const specPath = join(orch, 'backlog', '1-demo-feature.md');
    writeFileSync(specPath, TASK_SPEC);
    git(orch, 'add', '-A');
    git(orch, 'commit', '-m', 'chore: orchestration home baseline');

    const { syncBacklogFromSpecs } = await import('../lib/backlogSync.ts');
    const { ensureRunWorktree, cleanupRunWorktree } = await import('../lib/runWorktree.ts');
    const { markTaskDoneRuntimeOnly, writeSpecStatusDone } = await import('../lib/taskCompletion.ts');

    // Register the spec into runtime state.
    syncBacklogFromSpecs(stateDir, join(orch, 'backlog'));

    // Coordinator creates the run worktree: placed under the orchestration
    // .worktrees/, but a worktree OF the target repo.
    const runId = 'run-e2e-1';
    const entry = ensureRunWorktree(stateDir, { runId, taskRef: TASK_REF, agentId: 'orc-1' });
    expect(entry.worktree_path).toBe(join(orch, '.worktrees', runId));
    expect(git(entry.worktree_path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(join(product, '.git'));

    // Worker commits product-only changes inside the worktree.
    writeFileSync(join(entry.worktree_path, 'feature.txt'), 'new feature\n');
    git(entry.worktree_path, 'add', 'feature.txt');
    git(entry.worktree_path, 'commit', '-m', 'feat: add feature');

    // Coordinator merges the branch into the target repo's main.
    git(product, 'merge', entry.branch, '--no-ff', '-m', `task(${TASK_REF}): merge worktree`);

    // Coordinator records completion: runtime done + sibling spec writeback.
    markTaskDoneRuntimeOnly(TASK_REF, 'coordinator', stateDir);
    expect(writeSpecStatusDone(TASK_REF)).toEqual({ written: true, committed: true });

    // ── The target repo received only product code. ──
    expect(existsSync(join(product, 'feature.txt'))).toBe(true);
    expect(existsSync(join(product, 'product.txt'))).toBe(true);
    expect(git(product, 'log', '--oneline', '--all')).toContain('add feature');
    for (const artifact of ['.orc-state', '.worktrees', 'backlog', 'plans', 'orc-state.config.json']) {
      expect(existsSync(join(product, artifact))).toBe(false);
    }

    // ── The orchestration repo received the status writeback commit. ──
    expect(git(orch, 'log', '--oneline')).toContain(`chore(backlog): ${TASK_REF} done`);
    expect(readFileSync(specPath, 'utf8')).toContain('status: done');
    // Runtime state also reflects done, and converges (no revert) on re-sync.
    const runtimeStatus = () => {
      const backlog = JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8'));
      return backlog.features.flatMap((f: { tasks: Array<{ ref: string; status: string }> }) => f.tasks)
        .find((t: { ref: string }) => t.ref === TASK_REF)?.status;
    };
    expect(runtimeStatus()).toBe('done');
    syncBacklogFromSpecs(stateDir, join(orch, 'backlog'));
    expect(runtimeStatus()).toBe('done');

    // Cleanup runs against the target repo; the worktree is removed.
    expect(cleanupRunWorktree(stateDir, runId)).toBe(true);
    expect(existsSync(entry.worktree_path)).toBe(false);
  });
});
