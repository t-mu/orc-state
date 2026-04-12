---
ref: general/169-harden-pr-finalization-state-machine
feature: general
priority: high
status: todo
review_level: full
depends_on:
  - general/168-fix-pr-cli-config-and-doc-contract
---

# Task 169 — Fix PR CLI Config, PR Body Rendering, and Upstream Tracking

Depends on Task 168 (needs simplified single-worker PR flow).

## Scope

**In scope:**
- Fix all four `cli/pr-*.ts` commands to read `pr_provider` from coordinator config section
- Fix coordinator PR body rendering to pass `review_level` and `acceptance_criteria` to template
- Fix initial branch push to establish upstream tracking (`--set-upstream`)
- Update PR CLI tests for correct config shape
- Update git host adapter test for push args

**Out of scope:**
- Separate PR reviewer elimination (Task 168 — already done)
- Direct finalization path changes
- New git host adapter implementations
- Non-PR documentation updates

---

## Context

Three remaining bugs from the Codex audit after Task 168 eliminates the reviewer agent issues:

1. **CLI config path:** All four `cli/pr-*.ts` files read `rawConfig.pr_provider` from
   top-level JSON. The coordinator puts `pr_provider` under the `coordinator` section.
   A correctly-shaped `orc-state.config.json` with `{ "coordinator": { "pr_provider": "github" } }`
   fails with "pr_provider not configured." See `cli/pr-diff.ts:21-22`.

2. **Empty PR body:** `coordinator.ts` renders `pr-template-v1.txt` but only passes
   `task_ref`, `run_id`, `agent_id`, `branch`. The template has `{{review_level}}` and
   `{{acceptance_criteria}}` placeholders that render as empty. See line ~799.

3. **No upstream tracking:** `lib/gitHosts/github.ts:13` uses `git push remote branch`
   without `--set-upstream`. The worker's subsequent `git push --force-with-lease` may
   fail because git doesn't know which upstream to push to.

**Start here:** `cli/pr-diff.ts` line 21

**Affected files:**
- `cli/pr-diff.ts` — config fix
- `cli/pr-review.ts` — config fix
- `cli/pr-merge.ts` — config fix
- `cli/pr-status.ts` — config fix
- `cli/pr-diff.test.ts` — test config shape
- `cli/pr-review.test.ts` — test config shape
- `cli/pr-merge.test.ts` — test config shape
- `cli/pr-status.test.ts` — test config shape
- `coordinator.ts` — PR body rendering (~line 799)
- `lib/gitHosts/github.ts` — push with `--set-upstream`
- `lib/gitHosts/github.test.ts` — verify push args

---

## Goals

1. Must make all four `orc pr-*` commands read `coordinator.pr_provider` from nested config.
2. Must render PR body with `review_level` and `acceptance_criteria` populated.
3. Must push initial branch with `--set-upstream` for reliable subsequent force-pushes.
4. Must exit 1 with clear error when `coordinator.pr_provider` is absent.
5. Must preserve provider-agnostic design.

---

## Implementation

### Step 1 — Fix PR CLI config loading

**Files:** `cli/pr-diff.ts`, `cli/pr-review.ts`, `cli/pr-merge.ts`, `cli/pr-status.ts`

Replace the top-level config lookup:

```typescript
// Before:
const prProvider = typeof rawConfig.pr_provider === 'string' ? rawConfig.pr_provider : null;

// After:
const coordinator = (rawConfig.coordinator ?? rawConfig) as Record<string, unknown>;
const prProvider = typeof coordinator.pr_provider === 'string' ? coordinator.pr_provider : null;
```

### Step 2 — Update PR CLI tests

**Files:** `cli/pr-diff.test.ts`, `cli/pr-review.test.ts`, `cli/pr-merge.test.ts`, `cli/pr-status.test.ts`

Update config fixtures to `{ "coordinator": { "pr_provider": "github" } }`.
Add negative test: missing `coordinator.pr_provider` exits 1.

### Step 3 — Fix PR body rendering

**File:** `coordinator.ts`

At the `renderTemplate('pr-template-v1.txt', ...)` call (~line 799), add:

```typescript
const prBody = renderTemplate('pr-template-v1.txt', {
  task_ref: claim.task_ref,
  run_id: claim.run_id,
  review_level: task?.review_level ?? 'full',
  acceptance_criteria: task?.acceptance_criteria?.join('\n- ') ?? 'No criteria specified',
  agent_id: claim.agent_id,
  branch: runWorktree.branch,
});
```

### Step 4 — Fix initial branch push

**File:** `lib/gitHosts/github.ts`

```typescript
pushBranch(remote: string, branch: string): void {
  const result = spawnSync('git', ['push', '--set-upstream', remote, branch], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`git push failed: ${result.stderr}`);
}
```

Update `lib/gitHosts/github.test.ts` to assert `--set-upstream` in args.

---

## Acceptance criteria

- [ ] All four `orc pr-*` commands read `coordinator.pr_provider`.
- [ ] Each exits 1 with clear error when `coordinator.pr_provider` is missing.
- [ ] PR body includes `review_level` and `acceptance_criteria` (not empty).
- [ ] Initial branch push uses `--set-upstream`.
- [ ] PR CLI tests use nested config shape.
- [ ] `lib/gitHosts/github.test.ts` asserts `--set-upstream` in push args.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Update `cli/pr-*.test.ts`:
```typescript
it('reads pr_provider from coordinator config section', () => { ... });
it('exits 1 when coordinator.pr_provider is missing', () => { ... });
```

Add to `coordinator.test.ts`:
```typescript
it('renders PR body with review_level and acceptance_criteria', () => { ... });
```

Update `lib/gitHosts/github.test.ts`:
```typescript
it('pushBranch uses --set-upstream flag', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```
