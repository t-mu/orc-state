---
ref: general/170-align-pr-runtime-contracts-and-coverage
feature: general
priority: normal
status: cancelled
review_level: full
depends_on:
  - general/169-fix-pr-cli-body-upstream
---

# Task 170 — Align PR Runtime Contracts and Coverage

Depends on Task 169.

## Scope

**In scope:**
- Fix PR body rendering so required review context is actually passed into `pr-template-v1.txt`.
- Align branch push semantics with the reviewer bootstrap’s later `git push --force-with-lease`.
- Narrow “PR closed without merge” to the supported reviewer-driven failure contract and remove any misleading coordinator-owned expectation from tests/docs.
- Extend tests to cover these contract points.

**Out of scope:**
- General PR reviewer lifecycle bugs already covered by Task 169.
- Non-GitHub host support.
- Unrelated documentation cleanups outside the PR strategy path.

## Context

The current PR path scaffolding is mostly in place, but the contract between coordinator, git host adapter, templates, and tests is still inconsistent in three areas:

- `pr-template-v1.txt` requires `review_level` and `acceptance_criteria`, but the coordinator does not supply those values when rendering;
- the first branch push does not establish upstream tracking, but the reviewer bootstrap later assumes a plain `git push --force-with-lease` will work;
- tests claim the coordinator handles “PR closed without merge”, but the actual implementation does not check PR state at all — it only reacts if the reviewer fails.

This task should align the runtime contract so tests, templates, and implementation all describe the same behavior. For this task, the supported contract is explicit: external PR closure is not coordinator-polled state; it is represented as reviewer-reported failure unless a future task adds active coordinator PR-state checks.

**Affected files:**
- `coordinator.ts` — PR body rendering and optional PR-state handling.
- `lib/gitHosts/github.ts` — initial push semantics.
- `templates/pr-template-v1.txt` — keep placeholders aligned with runtime data.
- `templates/pr-reviewer-bootstrap-v1.txt` — update instructions if push semantics or PR-state ownership changes.
- `coordinator.test.ts` — contract-level regression coverage.
- `e2e/pr-lifecycle.e2e.test.ts` — align lifecycle expectations.
- `lib/gitHosts/github.test.ts` — assert exact git push behavior.

## Goals

1. Must ensure the rendered PR body includes the review context required by `pr-template-v1.txt`, or simplify the template to match available data.
2. Must make the initial branch push establish an upstream that is compatible with later `git push --force-with-lease`.
3. Must remove unsupported coordinator-owned “PR closed without merge” expectations and align tests/docs to the reviewer-driven failure contract.
4. Must keep Git host interactions provider-agnostic outside the adapter.
5. Must add tests for the chosen contract so it cannot silently drift again.

## Implementation

### Step 1 — Align PR body rendering with template placeholders

**Files:** `coordinator.ts`, `templates/pr-template-v1.txt`

Either:
- pass `review_level` and `acceptance_criteria` from the task/spec into `renderTemplate('pr-template-v1.txt', ...)`, or
- reduce the template to fields the coordinator actually owns.

Do not leave required-looking sections blank by accident.

### Step 2 — Fix initial branch push/upstream semantics

**Files:** `lib/gitHosts/github.ts`, `lib/gitHosts/github.test.ts`

Update the initial branch push so the reviewer’s later plain push works reliably. The likely fix is:

```ts
spawnSync('git', ['push', '--set-upstream', remote, branch], ...)
```

Then keep the reviewer bootstrap’s CI loop push as `git push --force-with-lease`.

### Step 3 — Narrow the “PR closed without merge” contract

**Files:** `coordinator.ts`, `coordinator.test.ts`, `e2e/pr-lifecycle.e2e.test.ts`

Use the supported reviewer-driven failure contract:

- do not claim coordinator support for external closure polling
- rewrite tests/docs so closure is represented as reviewer-reported failure, not coordinator polling
- keep any implementation changes limited to removing misleading expectations, not adding new coordinator polling logic

### Step 4 — Extend contract tests

**Files:** `coordinator.test.ts`, `e2e/pr-lifecycle.e2e.test.ts`, `lib/gitHosts/github.test.ts`

Add or update tests for:
- rendered PR body content
- upstream-establishing initial push
- chosen PR-closure behavior

## Acceptance criteria

- [ ] The PR body template and coordinator rendering agree on which fields are present.
- [ ] Initial branch push establishes upstream tracking compatible with reviewer `git push --force-with-lease`.
- [ ] Misleading coordinator-owned “PR closed without merge” expectations are removed from tests/docs.
- [ ] Contract tests cover the reviewer-driven failure behavior for PR closure.
- [ ] `lib/gitHosts/github.test.ts` asserts the exact initial push arguments.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

- Add a coordinator test that inspects the rendered PR body for review context.
- Update `lib/gitHosts/github.test.ts` to expect `git push --set-upstream <remote> <branch>` for the initial push.
- Update `e2e/pr-lifecycle.e2e.test.ts` so the PR-closed scenario matches the reviewer-driven failure contract.
- Remove or rewrite any coordinator tests that imply active PR-state polling for external closure.

## Verification

```bash
nvm use 24 && npm test
```

```bash
npx vitest run coordinator.test.ts e2e/pr-lifecycle.e2e.test.ts lib/gitHosts/github.test.ts
```

## Risk / Rollback

**Risk:** Changing push semantics or PR-state ownership can desynchronize the coordinator and reviewer bootstrap if only one side is updated.

**Rollback:** `git restore coordinator.ts lib/gitHosts/github.ts templates/pr-template-v1.txt templates/pr-reviewer-bootstrap-v1.txt coordinator.test.ts e2e/pr-lifecycle.e2e.test.ts lib/gitHosts/github.test.ts && npm test`
