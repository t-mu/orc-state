---
ref: lifecycle-verbs/181-harden-lifecycle-verbs-with-integration-coverage
feature: lifecycle-verbs
review_level: full
priority: normal
status: done
depends_on:
  - lifecycle-verbs/179-implement-spec-task-from-saved-plans
  - lifecycle-verbs/180-implement-interactive-plan-authoring-workflow
---

# Task 181 — Harden Lifecycle Verbs with Integration Coverage

Depends on Tasks 179 and 180.

## Scope

**In scope:**
- Add end-to-end and backward-compatibility coverage for the `/plan` and `/spec` lifecycle-verb flows.
- Verify the worktree → commit → merge-to-main flow works end to end: generated specs land in main's `backlog/` in the correct shape and are picked up by the coordinator's auto-sync on its next tick.
- Verify both `/spec plan <id>` and `/spec` (conversational fallback) invocation forms.
- Verify that existing non-plan backlog sync and task creation workflows still behave as before.
- Confirm that documentation updates owned by Tasks 176, 177, 179, and 180 are coherent and complete across AGENTS.md, `skills/orc-commands/SKILL.md`, and `docs/cli.md`. Fix doc gaps as they surface.

**Out of scope:**
- New lifecycle verbs beyond `/plan` and `/spec`.
- Redesigning the plan artifact contract unless tests expose a concrete defect.
- Provider-specific slash-command integrations.
- Open-ended "tighten anything you find" refactors — if integration testing exposes a defect outside the doc-coherence check, file a follow-up task and link it from this task. Fix in-task only if the test cannot merge green otherwise, and list any in-task fixes explicitly.

---

## Context

The earlier tasks introduce new file-backed planning artifacts (176), a reusable engine (177), and two new lifecycle verbs (`/plan`, `/spec`) exposed as MCP tools (179, 180). Each of those tasks owns its own documentation updates. This task exercises the real flow boundaries together, proves existing backlog workflows still behave, and closes any doc-coherence gaps that only become obvious when all four land together.

### Current state

Before this task, coverage is distributed across plan parsing, generation, `/spec` (both invocation forms), and `/plan` unit/integration tests. Documentation is updated in each task but has not been read end to end across the four landings.

### Desired state

The repo has a focused test set that covers the round-trip `/plan` → artifact → `/spec plan <id>` → backlog → merge flow, plus the conversational fallback form of `/spec`. The coordinator's existing auto-sync handles runtime-state updates; tests verify that the generated files reach main in the correct shape, not that the skill itself performs sync-check. Documentation across AGENTS.md, the orc-commands skill, and CLI docs reads coherently after all four tasks land.

### Start here

- `lib/planDocs.test.ts`
- `lib/planToBacklog.test.ts`
- `lib/planSpecTask.test.ts`
- `lib/planAuthoring.test.ts`
- `mcp/handlers.test.ts`
- `cli/backlog-sync-check.test.ts`
- `AGENTS.md`, `skills/orc-commands/SKILL.md`, `docs/cli.md` — verify cross-task coherence

**Affected files:**
- `lib/planSpecTask.test.ts` or a new focused integration test file — round-trip coverage
- `cli/backlog-sync-check.test.ts` — backward-compat assertions
- `AGENTS.md`, `skills/orc-commands/SKILL.md`, `docs/cli.md` — doc-coherence fixes only if cross-task landings left gaps

---

## Goals

1. Must prove `/plan` produces a valid saved plan artifact that `/spec plan <id>` can consume after merge.
2. Must prove `/spec` without args (conversational fallback) extracts a plan from chat, persists it via `plan_write`, and proceeds through publish and merge successfully.
3. Must prove generated backlog task specs carry `feature: <plan.name>` and a valid `review_level` in `'none' | 'light' | 'full'`.
4. Must prove the worktree → commit → merge flow: specs are invisible to main's `backlog/` before merge, and present in the correct shape after merge. The skill itself does NOT run sync-check; the test may optionally invoke `orc backlog-sync-check` as ad-hoc verification but not as a flow gate.
5. Must prove stale staging and pre-existing `derived_task_refs` both hard-fail.
6. Must prove existing non-plan backlog sync and task creation workflows remain unchanged.
7. Must confirm that AGENTS.md, `skills/orc-commands/SKILL.md`, and `docs/cli.md` describe `/plan`, `/spec`, the `plans/` directory, and the MCP tools coherently after all four tasks land. Fix doc gaps in this task.
8. If integration testing surfaces a code defect, the task owns **either** an in-task fix (if required to merge green) or a linked follow-up task. Both options are explicit — no silent refactors.

---

## Implementation

### Step 1 — End-to-end round-trip coverage

**File:** `lib/planSpecTask.test.ts` and/or a new focused integration test file

Add a test that:
- Creates a worktree (or fixture representing one)
- Invokes `plan_write` to persist a valid plan artifact in the worktree
- Simulates the commit + merge-to-main step
- Invokes `spec_publish(plan_id, { confirm: true })` in a second (simulated) worktree
- Simulates the commit + merge-to-main step
- Verifies every created ref is present in main's `backlog/` in the correct shape
- Verifies `feature: <plan.name>` propagation and `review_level` validity on every generated spec

### Step 2 — Conversational fallback coverage

**File:** `lib/planSpecTask.test.ts` and/or new file

Exercise the `/spec` conversational fallback path end-to-end:
- Skill-level simulation (or a dedicated test harness) feeds a plan printed in chat
- The test persists it via `plan_write`
- Runs preview + publish
- Verifies the same round-trip outcome as Step 1

### Step 3 — Backward-compatibility coverage

**File:** `cli/backlog-sync-check.test.ts` or the most appropriate existing test module

Add assertions that pre-existing backlog sync and task-creation behavior still works when lifecycle-verbs support is present. In particular: tasks created via the traditional `backlog/<N>-<slug>.md` hand-authored path sync normally; `backlog-sync-check --refs=...` on those refs behaves as before.

### Step 4 — Documentation coherence sweep

Read AGENTS.md, `skills/orc-commands/SKILL.md`, and `docs/cli.md` end to end after Tasks 176, 177, 179, and 180 have landed. Verify:
- `/plan` and `/spec` are described in both AGENTS.md and `docs/cli.md` with matching semantics.
- `skills/orc-commands/SKILL.md` lists all new MCP tools (`plan_write`, `spec_preview`, `spec_publish`) and references the correct skill directories (`skills/plan/`, `skills/spec/`).
- The `plans/` artifact directory is described consistently.
- The worktree + merge-to-main expectation is expressed the same way across all three documents.

Fix any coherence gaps directly in this task. Larger rewrites should be captured as follow-up tasks.

---

## Acceptance criteria

- [ ] A round-trip test exists: `plan_write` produces a saved plan, `spec_publish` consumes it, and the generated specs reach main's `backlog/` in the correct shape after merge.
- [ ] Conversational fallback test exists: `/spec` with no args persists a chat-extracted plan via `plan_write`, then publishes successfully.
- [ ] Integration coverage asserts `feature: <plan.name>` propagation and `review_level` in `'none' | 'light' | 'full'` on every generated backlog spec.
- [ ] Integration coverage asserts specs are invisible to the coordinator before merge and visible after merge.
- [ ] Integration coverage asserts stale staging and pre-existing `derived_task_refs` hard-fail.
- [ ] Backward-compatibility tests confirm existing non-plan backlog flows still work.
- [ ] AGENTS.md, `skills/orc-commands/SKILL.md`, and `docs/cli.md` describe `/plan`, `/spec`, the `plans/` directory, and the MCP tools coherently. Any cross-task gaps are closed in this task or captured as follow-ups.
- [ ] Any in-task fixes are explicitly listed; anything else goes into a linked follow-up task.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update targeted tests covering:

```ts
it('round-trips from plan_write → merge → spec_publish → merge and reaches main in correct shape', () => { ... });
it('handles /spec conversational fallback (no plan id) end to end', () => { ... });
it('propagates the plan feature slug and review_level into generated backlog specs', () => { ... });
it('specs are absent from main before merge and present after merge', () => { ... });
it('preserves existing backlog sync behavior for non-plan workflows', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/planDocs.test.ts lib/planToBacklog.test.ts lib/planSpecTask.test.ts lib/planAuthoring.test.ts mcp/handlers.test.ts cli/backlog-sync-check.test.ts
```

```bash
nvm use 24 && npm test
```
