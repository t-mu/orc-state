---
ref: lifecycle-verbs/181-harden-lifecycle-verbs-with-integration-coverage
feature: lifecycle-verbs
review_level: full
priority: normal
status: todo
depends_on:
  - lifecycle-verbs/179-implement-spec-task-from-saved-plans
  - lifecycle-verbs/180-implement-interactive-plan-authoring-workflow
---

# Task 181 — Harden Lifecycle Verbs with Integration Coverage

Depends on Tasks 179 and 180.

## Scope

**In scope:**
- Add end-to-end and backward-compatibility coverage for the saved-plan lifecycle-verbs flow.
- Verify the narrow `/spec task <id>` and `/plan ...` flows work together without regressing existing backlog/task behavior.
- Tighten any remaining edge handling discovered by the new integration coverage.

**Out of scope:**
- New lifecycle verbs beyond `/plan` and `/spec task <id>`.
- Redesigning the plan artifact contract or worktree lifecycle shape unless tests expose a concrete defect.
- Provider-specific slash-command integrations.

---

## Context

The earlier tasks introduce new file-backed planning artifacts, a new generation engine, new master worktree behavior, and two new lifecycle verbs. Those pieces need one final hardening pass that exercises the real flow boundaries together and proves existing backlog/task workflows still behave as before.

This task is intentionally late in the sequence so the compatibility and integration assertions are written against the real implementation rather than assumptions.

### Current state

Before this task, coverage will be distributed across plan parsing, generation, worktree helpers, `/spec task <id>`, and `/plan` unit/integration tests. There is not yet a single final pass that proves the lifecycle-verbs path works end to end and that non-plan backlog workflows remain intact.

### Desired state

The repo has a focused test set that covers `/plan` authoring, `/spec task <id>` conversion, worktree-backed review/refinement flow, scoped sync-check behavior, and backward compatibility for existing backlog creation and sync paths.

### Start here

- `lib/planDocs.test.ts`
- `lib/planToBacklog.test.ts`
- `lib/planSpecTask.test.ts`
- `lib/planAuthoring.test.ts`
- `cli/backlog-sync-check.test.ts`

**Affected files:**
- `test/` or existing `*.test.ts` files in `lib/`, `cli/`, and `mcp/` — add end-to-end lifecycle-verbs coverage in the repo’s established location
- `templates/master-bootstrap-v1.txt` — only if integration testing reveals command-routing gaps

---

## Goals

1. Must prove `/plan` can produce a valid saved plan artifact that `/spec task <id>` can consume.
2. Must prove generated backlog task specs carry `feature: <plan.name>`.
3. Must prove scoped `orc backlog-sync-check --refs=...` success and failure handling.
4. Must prove stale staging and pre-existing `derived_task_refs` still fail by default.
5. Must prove existing non-plan backlog sync and task creation workflows remain unchanged.

---

## Implementation

### Step 1 — Add end-to-end lifecycle-verbs coverage

**File:** `lib/planSpecTask.test.ts` and/or a new focused integration test file

Add a test that:
- authors or seeds a valid plan artifact
- runs the `/spec task <id>` flow
- verifies created backlog refs, feature propagation, and writeback behavior

### Step 2 — Add `/plan` to `/spec task <id>` round-trip coverage

**File:** `lib/planAuthoring.test.ts` and/or a new integration test file

Exercise the full round trip from `/plan` authoring to saved plan to `/spec task <id>` conversion using the same artifact contract.

### Step 3 — Add backward-compatibility coverage

**File:** `cli/backlog-sync-check.test.ts` or the most appropriate existing test modules

Add assertions that pre-existing backlog sync and task-creation behavior still works when lifecycle-verbs support is present.

---

## Acceptance criteria

- [ ] A round-trip test exists for `/plan` producing a saved plan that `/spec task <id>` consumes.
- [ ] Integration coverage asserts feature propagation from `plan.name` into generated backlog task specs.
- [ ] Integration coverage asserts scoped sync-check behavior and failure handling.
- [ ] Backward-compatibility tests confirm existing non-plan backlog flows still work.
- [ ] Any hardening changes made in response to test failures stay within lifecycle-verbs scope.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update targeted tests covering:

```ts
it('round-trips from /plan authoring to /spec task conversion', () => { ... });
it('propagates the plan feature slug into generated backlog specs', () => { ... });
it('preserves existing backlog sync behavior for non-plan workflows', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planDocs.test.ts lib/planToBacklog.test.ts lib/planSpecTask.test.ts lib/planAuthoring.test.ts cli/backlog-sync-check.test.ts
```

```bash
nvm use 24 && npm test
```
