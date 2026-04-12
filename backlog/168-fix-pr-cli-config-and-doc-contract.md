---
ref: general/168-fix-pr-cli-config-and-doc-contract
feature: general
priority: high
status: todo
review_level: light
---

# Task 168 — Fix PR CLI Config Loading and Contract Docs

Independent.

## Scope

**In scope:**
- Fix `cli/pr-diff.ts`, `cli/pr-review.ts`, `cli/pr-merge.ts`, and `cli/pr-status.ts` to read PR provider config from the canonical coordinator config shape.
- Update the PR CLI tests under `cli/` to use the same nested config shape as runtime.
- Correct stale completion-contract documentation in `docs/cli.md`, `docs/contracts.md`, and `AGENTS.md` where they still describe the old worker-owned `task-mark-done` behavior.

**Out of scope:**
- Coordinator PR state-machine changes in `coordinator.ts`.
- Git host adapter behavior such as branch push semantics.
- PR reviewer bootstrap or template content changes.

## Context

The new `orc pr-*` commands were added as provider-agnostic wrappers, but they currently parse `pr_provider` from the top level of the config JSON instead of `coordinator.pr_provider`. That makes the commands fail against the documented configuration layout even when the PR feature is configured correctly.

The CLI docs also still describe `task-mark-done` as updating both spec frontmatter and runtime state. That is now wrong: runtime completion is coordinator-owned after merge. Leaving that stale text in place makes the PR workflow and normal direct-finalization workflow harder to reason about.

**Affected files:**
- `cli/pr-diff.ts` — load `coordinator.pr_provider` from canonical config.
- `cli/pr-review.ts` — same config fix for review submission.
- `cli/pr-merge.ts` — same config fix for merge execution.
- `cli/pr-status.ts` — same config fix for status/CI wait.
- `cli/pr-diff.test.ts` — update fixtures/assertions to nested config.
- `cli/pr-review.test.ts` — update fixtures/assertions to nested config.
- `cli/pr-merge.test.ts` — update fixtures/assertions to nested config.
- `cli/pr-status.test.ts` — update fixtures/assertions to nested config.
- `docs/cli.md` — correct task completion wording and keep PR command docs aligned.
- `docs/contracts.md` — update completion lifecycle ownership text to match coordinator-owned runtime completion.
- `AGENTS.md` — update worker guidance so it no longer instructs worker-owned runtime `task-mark-done`.

## Goals

1. Must make all four `orc pr-*` commands work with `coordinator.pr_provider` in `orchestrator.config.json` via the canonical `ORC_CONFIG_FILE` path.
2. Must keep the commands provider-agnostic and free of direct `gh`/`glab` references.
3. Must preserve current CLI usage and error handling for missing `pr_ref`.
4. Must exit 1 with a clear error when `coordinator.pr_provider` is absent.
5. Must update CLI docs so `task-mark-done` no longer claims worker-side spec mutation.

## Implementation

### Step 1 — Normalize PR CLI config loading

**File:** `cli/pr-diff.ts`

Replace the ad-hoc top-level JSON lookup with config parsing that reads the coordinator block:

```ts
const rawConfig = existsSync(configFile)
  ? JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
  : {};
const coordinator = (rawConfig.coordinator ?? {}) as Record<string, unknown>;
const prProvider = typeof coordinator.pr_provider === 'string' ? coordinator.pr_provider : null;
```

Apply the same shape to:
- `cli/pr-review.ts`
- `cli/pr-merge.ts`
- `cli/pr-status.ts`

Do not widen support to multiple config formats. These commands should follow the canonical runtime schema, not accept legacy drift.

### Step 2 — Update command tests to the real config shape

**Files:**
- `cli/pr-diff.test.ts`
- `cli/pr-review.test.ts`
- `cli/pr-merge.test.ts`
- `cli/pr-status.test.ts`

Update test fixtures from:

```json
{ "pr_provider": "github" }
```

to:

```json
{ "coordinator": { "pr_provider": "github" } }
```

Add one explicit negative test showing that a config file with no `coordinator.pr_provider` still exits 1.

### Step 3 — Correct stale completion-contract docs

**Files:** `docs/cli.md`, `docs/contracts.md`, `AGENTS.md`

Update the `task-mark-done` and completion-lifecycle descriptions so they match the current contract:
- coordinator-owned runtime completion after merge
- worker updates task markdown in the worktree; coordinator marks runtime done after merge
- not a worker-side “update spec + runtime” action

Keep the PR commands section intact, but make sure it references the same config terminology used by the code.

## Acceptance criteria

- [ ] `orc pr-diff`, `orc pr-review`, `orc pr-merge`, and `orc pr-status` all read `coordinator.pr_provider`.
- [ ] Each PR CLI exits 1 with a clear error when `coordinator.pr_provider` is missing.
- [ ] Existing positional `pr_ref` parsing still works.
- [ ] PR CLI tests use the nested config shape rather than a top-level `pr_provider`.
- [ ] `docs/cli.md`, `docs/contracts.md`, and `AGENTS.md` no longer state that `task-mark-done` is a worker-owned “update spec + runtime” action.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

- Update `cli/pr-diff.test.ts` to write `{ coordinator: { pr_provider: 'github' } }`.
- Update `cli/pr-review.test.ts` to write `{ coordinator: { pr_provider: 'github' } }`.
- Update `cli/pr-merge.test.ts` to write `{ coordinator: { pr_provider: 'github' } }`.
- Update `cli/pr-status.test.ts` to write `{ coordinator: { pr_provider: 'github' } }`.
- Add one negative assertion per command that missing `coordinator.pr_provider` exits 1.

## Verification

```bash
nvm use 24 && npm test
```
