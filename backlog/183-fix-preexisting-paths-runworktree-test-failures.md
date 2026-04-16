---
ref: test-infra/183-fix-preexisting-paths-runworktree-test-failures
feature: test-infra
review_level: full
priority: normal
status: todo
---

# Task 183 — Fix Pre-existing paths/runWorktree Test Failures

Independent.

## Scope

**In scope:**
- Diagnose and fix `lib/paths.test.ts` failures for `defaults STATE_DIR to the canonical repo root instead of the ambient cwd` and `hookEventPath returns per-agent ndjson file under pty-hook-events`.
- Diagnose and fix `lib/runWorktree.test.ts` failures (5 cases under `ensureRunWorktree`) reproducible against current `main`.

**Out of scope:**
- Refactoring `lib/paths.ts` or `lib/runWorktree.ts` beyond what the test fixes require.
- Unrelated test cleanup.

---

## Context

Surfaced during Task 181 (lifecycle-verbs integration coverage). `npm test` exits non-zero on a clean checkout of `main` because of 7 pre-existing failures across these two files. The lifecycle-verbs work does not touch either module; the failures reproduce on a fresh `git clone` of `main` and against this worktree with the lifecycle-verbs integration test file removed. Filed as a follow-up per Task 181's "linked follow-up task" policy.

### Current state

- `lib/paths.test.ts > paths > defaults STATE_DIR to the canonical repo root ...` expects `/tmp/repo-root/.orc-state` but gets the real repo path. The `vi.doMock('./repoRoot.ts', ...)` is not being honored by the `await import('./paths.ts')` that follows `vi.resetModules()`.
- `lib/paths.test.ts > paths > hookEventPath returns per-agent ndjson file ...` fails for the same reason.
- `lib/runWorktree.test.ts > ensureRunWorktree` cases assume `child_process.spawnSync` is mocked, but the first call that leaks to the real git binary (or a real worktree path) breaks their expectations.

### Desired state

`npm test` exits 0 on a clean `main` checkout.

### Start here

- `lib/paths.test.ts`
- `lib/paths.ts`
- `lib/runWorktree.test.ts`
- `lib/runWorktree.ts`

**Affected files:**
- `lib/paths.test.ts` — restore the `vi.doMock` → `vi.resetModules` → `await import` ordering so the mock is honored.
- `lib/runWorktree.test.ts` — restore mock coverage for `spawnSync` and filesystem probes.
- Possibly a top-level test isolation fix if a shared fixture is leaking cwd state.

---

## Goals

1. Must make `npx vitest run lib/paths.test.ts` exit 0 on a clean checkout.
2. Must make `npx vitest run lib/runWorktree.test.ts` exit 0 on a clean checkout.
3. Must not introduce flakiness in other tests that share `paths.ts` / `runWorktree.ts` imports.
4. Must not silence or skip the failing cases — the intent is to fix the assertion, not to delete it.

---

## Acceptance criteria

- [ ] `npx vitest run lib/paths.test.ts lib/runWorktree.test.ts` exits 0.
- [ ] `nvm use 24 && npm test` exits 0 on a clean `main` checkout.
- [ ] No changes to public APIs of `lib/paths.ts` or `lib/runWorktree.ts` unless the fix genuinely requires it — in which case callers are updated and the change is documented in the commit message.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
npx vitest run lib/paths.test.ts lib/runWorktree.test.ts
```

```bash
nvm use 24 && npm test
```
