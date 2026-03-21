---
ref: general/26-fix-spawn-sync-result-error
feature: general
priority: high
status: todo
---

# Task 26 — Fix spawnSync result.error in git calls

Independent.

## Scope

**In scope:**
- `lib/runWorktree.ts` — add `result.error` check in `ensureGitWorktree()` and improve error detail in both `cleanupRunWorktree()` spawnSync calls
- `coordinator.ts` — add `result.error` check in `branchContainsMain()` and `mergeTaskBranch()`
- `lib/runWorktree.test.ts` — add a test verifying the error is surfaced when spawnSync fails to spawn

**Out of scope:**
- `lib/repoRoot.ts` — its `result.status !== 0` fallback to `cwd` is intentional; do not change it
- Any spawnSync call not listed above
- Adding git operation timeouts (Task 27)

---

## Context

`spawnSync` returns `{ status: null, error: Error, stdout: '', stderr: '' }` when the process fails to spawn (e.g., cwd does not exist, binary not on PATH). The current error-handling code in git call sites checks only `result.status` and `result.stderr`/`result.stdout`. Since both output buffers are empty on a spawn failure, the thrown/logged message is empty or generic ("unknown error"), making the root cause invisible.

This caused the production `"dispatch_error: Failed to allocate worktree ... ''"` bug — a ghost coordinator running from a deleted worktree directory caused all subsequent `git worktree add` spawns to fail silently with an empty error message.

### Current state

- `ensureGitWorktree()` throws `"Failed to allocate worktree /path: "` (empty detail) when git spawn fails because `result.status` is `null`, `null !== 0` is `true`, but `stderr` and `stdout` are both `""`.
- `branchContainsMain()` falls through to throw `"git merge-base failed for branch: unknown error"` since `null` is neither `0` nor `1`, but `stderr` is empty.
- `mergeTaskBranch()` same empty-message pattern.
- Both `cleanupRunWorktree()` warn calls show `"unknown error"` with no OS detail.

### Desired state

- All five call sites surface the real OS error (`result.error.message`, e.g. `spawnSync git ENOENT`) when spawn fails.
- The error message in `ensureGitWorktree()` and `mergeTaskBranch()` includes the underlying `Error` object.
- The cleanup warn messages include `result.error?.message` when available.
- `branchContainsMain()` throws the underlying `result.error` immediately before the status checks.

### Start here

- `lib/runWorktree.ts:18–35` — `ensureGitWorktree()` and its spawnSync call
- `lib/runWorktree.ts:59–108` — `cleanupRunWorktree()` and its two spawnSync calls (lines 74–81, 88–95)
- `coordinator.ts:361–379` — `branchContainsMain()` and `mergeTaskBranch()`

**Affected files:**
- `lib/runWorktree.ts` — three spawnSync call sites
- `coordinator.ts` — two spawnSync call sites
- `lib/runWorktree.test.ts` — new test for spawn failure

---

## Goals

1. Must: `ensureGitWorktree()` throws the underlying `result.error` (OS error) when git fails to spawn, not an empty-message Error.
2. Must: `mergeTaskBranch()` throws `result.error` when git fails to spawn.
3. Must: `branchContainsMain()` throws `result.error` when git fails to spawn (before the `=== 0`/`=== 1` status checks).
4. Must: both `cleanupRunWorktree()` warn calls include `result.error?.message` in the logged detail when available.
5. Must: `lib/repoRoot.ts` is not modified.
6. Must: all existing error messages for non-zero exit codes are preserved unchanged.
7. Must: `npm test` passes with no regressions.

---

## Implementation

### Step 1 — Fix ensureGitWorktree in lib/runWorktree.ts

**File:** `lib/runWorktree.ts`

Change lines 28–34 from:
```typescript
const result = spawnSync('git', args, {
  cwd: root,
  encoding: 'utf8',
});
if (result.status !== 0) {
  throw new Error(`Failed to allocate worktree ${path}: ${(result.stderr || result.stdout || '').trim()}`);
}
```
To:
```typescript
const result = spawnSync('git', args, {
  cwd: root,
  encoding: 'utf8',
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Failed to allocate worktree ${path}: ${(result.stderr || result.stdout || '').trim()}`);
}
```

### Step 2 — Fix both cleanup spawnSync calls in lib/runWorktree.ts

**File:** `lib/runWorktree.ts`

In `cleanupRunWorktree()`, update both `if (result.status !== 0)` blocks to also check `result.error` and include it in the logged detail.

For the worktree remove call (lines 74–81), change from:
```typescript
if (result.status !== 0) {
  cleanupSucceeded = false;
  console.warn(`[runWorktree] worktree remove failed for ${entry.worktree_path}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
}
```
To:
```typescript
if (result.status !== 0 || result.error) {
  cleanupSucceeded = false;
  const detail = result.error?.message ?? (result.stderr || result.stdout || 'unknown error').trim();
  console.warn(`[runWorktree] worktree remove failed for ${entry.worktree_path}: ${detail}`);
}
```

For the branch delete call (lines 88–95), change from:
```typescript
if (result.status !== 0) {
  cleanupSucceeded = false;
  console.warn(`[runWorktree] branch delete failed for ${entry.branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
}
```
To:
```typescript
if (result.status !== 0 || result.error) {
  cleanupSucceeded = false;
  const detail = result.error?.message ?? (result.stderr || result.stdout || 'unknown error').trim();
  console.warn(`[runWorktree] branch delete failed for ${entry.branch}: ${detail}`);
}
```

### Step 3 — Fix branchContainsMain in coordinator.ts

**File:** `coordinator.ts`

Change `branchContainsMain()` (lines 361–369) from:
```typescript
function branchContainsMain(branch: string) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', 'main', branch], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
}
```
To:
```typescript
function branchContainsMain(branch: string) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', 'main', branch], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
}
```

### Step 4 — Fix mergeTaskBranch in coordinator.ts

**File:** `coordinator.ts`

Change `mergeTaskBranch()` (lines 371–379) from:
```typescript
function mergeTaskBranch(branch: string, taskRef: string) {
  const result = spawnSync('git', ['merge', branch, '--no-ff', '-m', `task(${taskRef}): merge worktree`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git merge failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
}
```
To:
```typescript
function mergeTaskBranch(branch: string, taskRef: string) {
  const result = spawnSync('git', ['merge', branch, '--no-ff', '-m', `task(${taskRef}): merge worktree`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git merge failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
}
```

### Step 5 — Add test for spawn failure in lib/runWorktree.test.ts

**File:** `lib/runWorktree.test.ts`

Add a test to the `ensureRunWorktree` describe block, following the existing `vi.doMock('node:child_process')` pattern:

```typescript
it('throws the underlying OS error when git spawn fails', async () => {
  vi.resetModules(); // required — ensures vi.doMock applies to a fresh import
  const spawnError = new Error('spawnSync git ENOENT');
  const spawnSync = vi.fn()
    .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git'), stderr: '' }) // resolveRepoRoot
    .mockReturnValueOnce({ status: null, error: spawnError, stdout: '', stderr: '', pid: 0, output: [], signal: null }); // git worktree add

  vi.doMock('node:child_process', () => ({ spawnSync }));
  const { ensureRunWorktree } = await import('./runWorktree.ts');

  expect(() =>
    ensureRunWorktree(dir, { runId: 'run-fail', taskRef: 'general/26', agentId: 'orc-1' }),
  ).toThrow('spawnSync git ENOENT');
});
```

---

## Acceptance criteria

- [ ] `ensureGitWorktree()`: when spawnSync returns `{ status: null, error: new Error('spawnSync git ENOENT') }`, the thrown error message is `'spawnSync git ENOENT'` (not empty).
- [ ] `mergeTaskBranch()`: same — spawn failure throws the OS error, not a generic empty-message error.
- [ ] `branchContainsMain()`: same — spawn failure throws the OS error before the status checks run.
- [ ] Both `cleanupRunWorktree()` warn calls include the OS error message in their log output when spawn fails.
- [ ] `lib/repoRoot.ts` is unchanged.
- [ ] The new test in `lib/runWorktree.test.ts` passes.
- [ ] All existing passing tests continue to pass (`npm test`).
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/runWorktree.test.ts` inside the `ensureRunWorktree` describe block:

```typescript
it('throws the underlying OS error when git spawn fails', async () => {
  vi.resetModules(); // required — ensures the vi.doMock below applies to a fresh import
  const spawnError = new Error('spawnSync git ENOENT');
  const spawnSync = vi.fn()
    .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git'), stderr: '' }) // resolveRepoRoot
    .mockReturnValueOnce({ status: null, error: spawnError, stdout: '', stderr: '', pid: 0, output: [], signal: null }); // git worktree add
  vi.doMock('node:child_process', () => ({ spawnSync }));
  const { ensureRunWorktree } = await import('./runWorktree.ts');
  expect(() =>
    ensureRunWorktree(dir, { runId: 'run-fail', taskRef: 'general/26', agentId: 'orc-1' }),
  ).toThrow('spawnSync git ENOENT');
});
```

---

## Verification

```bash
npx vitest run lib/runWorktree.test.ts
```

```bash
nvm use 24 && npm test
```
