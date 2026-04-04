---
ref: publish/123-backlog-path-worktree-aware
feature: publish
priority: high
status: done
---

# Task 123 — Make Backlog Spec Lookup Worktree-Aware

Independent.

## Scope

**In scope:**
- Change `activeBacklogDocsDir()` in `lib/taskAuthority.ts` to resolve `backlog/` relative to cwd instead of the main repo root
- Verify `create_task` and `backlog-sync-check` work from worktrees

**Out of scope:**
- Changing `STATE_DIR` resolution (state files should remain in the main checkout's `.orc-state/`)
- Changing `BACKLOG_DOCS_DIR` in `lib/paths.ts` (used elsewhere; this task only changes `taskAuthority.ts`)
- Changing how `resolveRepoRoot()` works
- Adding new environment variables

---

## Context

### Current state

`activeBacklogDocsDir()` in `lib/taskAuthority.ts:9-11` resolves to the main repo
root's `backlog/` directory:

```typescript
function activeBacklogDocsDir(): string {
  if (process.env.ORC_BACKLOG_DIR) return resolve(process.env.ORC_BACKLOG_DIR);
  return resolve(resolveRepoRoot(), 'backlog');
}
```

`resolveRepoRoot()` uses `git rev-parse --git-common-dir` which always returns the
main repo's `.git` dir, even from a worktree. So `create_task` always looks for
specs in the main checkout's `backlog/`, not the worktree's.

When authoring a new task in a worktree, the spec exists in the worktree's `backlog/`
but not yet in main (it arrives there after merge). This forces a workaround of
copying the spec to main before calling `create_task`, which then causes merge
conflicts when the worktree branch is merged.

### Desired state

`activeBacklogDocsDir()` resolves `backlog/` relative to the current working
directory. In a worktree, the worktree's `backlog/` is a superset of main's
(same files plus any new specs). This makes `create_task` work naturally from
worktrees without copying files to main.

### Start here

- `lib/taskAuthority.ts` — `activeBacklogDocsDir()` function
- `mcp/handlers.ts` — `handleCreateTask` which calls `assertTaskSpecMatchesRegistration`

**Affected files:**
- `lib/taskAuthority.ts` — change path resolution in `activeBacklogDocsDir()`

---

## Goals

1. Must resolve `backlog/` relative to cwd (not main repo root) in `activeBacklogDocsDir()`
2. Must work from both main checkout and worktrees
3. Must not change `STATE_DIR` resolution (state stays in main's `.orc-state/`)
4. Must pass `backlog-sync-check` from both main checkout and worktree contexts

---

## Implementation

### Step 1 — Change `activeBacklogDocsDir()` path resolution

**File:** `lib/taskAuthority.ts`

```typescript
function activeBacklogDocsDir(): string {
  if (process.env.ORC_BACKLOG_DIR) return resolve(process.env.ORC_BACKLOG_DIR);
  return resolve('backlog');
}
```

Remove the `resolveRepoRoot()` import if no longer used in this file.

---

## Acceptance criteria

- [ ] `activeBacklogDocsDir()` resolves to cwd-relative `backlog/`
- [ ] `create_task` finds specs when run from a worktree
- [ ] `create_task` still works from the main checkout
- [ ] `backlog-sync-check` passes from both contexts
- [ ] `npm test` passes
- [ ] No changes to `STATE_DIR` or `resolveRepoRoot()`

---

## Tests

Add to `mcp/handlers.test.ts`:

```typescript
it('finds task spec in cwd backlog/ regardless of repo root', () => { ... });
```

---

## Verification

```bash
npx vitest run mcp/handlers.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc backlog-sync-check
```
