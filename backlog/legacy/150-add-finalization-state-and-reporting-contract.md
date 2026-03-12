---
ref: orch/task-150-add-finalization-state-and-reporting-contract
epic: orch
status: done
---

# Task 150 — Add Finalization State and Reporting Contract

Depends on Task 149.

## Scope

**In scope:**
- orchestrator run/claim state handling under `lib/claimManager.mjs` and related helpers — add explicit finalization-phase state
- event/reporting validation under `lib/eventValidation.mjs`, `lib/progressValidation.mjs`, and related schema/tests — support finalization-phase events or statuses
- `cli/run-*.mjs` and/or `cli/progress.mjs` — allow the agent to report work-complete / ready-to-merge transitions
- state/schema changes required to store finalization retry count and blocked finalization reason

**Out of scope:**
- Coordinator merge attempt logic
- Provider/worktree launch implementation
- Status formatting and operator docs
- Cleanup of merged worktrees

---

## Context

Once the agent stops self-merging, the orchestrator needs a first-class finalization phase in state and reporting. “Done coding” is no longer equivalent to “merged.” The system must distinguish between implementation completion, waiting for merge, being asked to rebase again, and being blocked after retries.

Without this state model, the coordinator cannot drive a proper finalization loop or preserve work safely when merge-time rebases fail.

### Current state

The orchestrator mostly distinguishes active work and terminal success/failure. There is no durable state for “work complete but still waiting for merge” or “finalization blocked after retries.”

The reporting CLI and event validation path do not provide a clear contract for finalization-phase transitions.

### Desired state

The run/claim model should include an explicit finalization phase with enough state to represent:
- task work complete
- waiting for merge attempt
- finalize rebase requested
- finalize rebase in progress
- ready to merge again
- blocked after two failed finalize retries

The agent should be able to report those transitions through existing or extended reporting commands in a machine-checkable way.

### Start here

- `lib/claimManager.mjs` — current run/claim lifecycle handling
- `lib/eventValidation.mjs` and `lib/progressValidation.mjs` — current event contract
- `cli/run-start.mjs`, `run-finish.mjs`, `run-fail.mjs`, and `progress.mjs` — current worker reporting surface

<!-- Optional:
### Dependency context

Task 149 changes the agent contract and introduces the first non-terminal handoff signal. This task expands that into a durable finalization state model with proper reporting hooks for coordinator-driven retries.
-->

**Affected files:**
- `lib/claimManager.mjs` — finalization-phase lifecycle
- `lib/eventValidation.mjs` — allowed event types/payloads
- `lib/progressValidation.mjs` — reporting validation rules
- reporting CLIs under `cli/` — emit finalization-phase signals
- any touched schema/state validation files

---

## Goals

1. Must introduce explicit finalization-phase state distinct from implementation success/failure.
2. Must track finalization retry count and blocked finalization reason durably.
3. Must let the agent report work-complete, finalize-rebase-started, and ready-to-merge transitions through validated CLI events or state updates.
4. Must preserve the distinction between implementation failure and blocked finalization.
5. Must prepare the coordinator for a two-retry finalize loop without implementing that loop in this task.

---

## Implementation

### Step 1 — Extend claim/run state for finalization

**Files:**
- `lib/claimManager.mjs`
- any touched state/schema validation files

Add explicit finalization-phase states and counters. Keep the model precise enough that later coordinator logic can tell whether a run is waiting for merge, currently being finalized, or blocked after retries.

### Step 2 — Extend reporting validation and CLI surface

**Files:**
- `lib/eventValidation.mjs`
- `lib/progressValidation.mjs`
- reporting CLIs under `cli/`

Add the events or reporting modes needed for the agent to signal:
- work complete / awaiting finalize
- finalize rebase started / in progress
- ready to merge after a finalize rebase

Coordinator-owned blocked finalization after retry exhaustion remains out of scope here; this task should not let the agent bypass that coordinator policy by directly declaring the run blocked-finalize.

### Step 3 — Cover the new lifecycle in tests

**Files:**
- `lib/claimManager.test.mjs`
- `cli/run-reporting.test.mjs`
- validation tests near the touched event/progress validators

---

## Acceptance criteria

- [ ] The orchestrator has explicit finalization-phase state distinct from implementation completion and terminal failure.
- [ ] Finalization retry count and blocked reason are stored durably.
- [ ] The agent can report work-complete, finalize-rebase-started, and ready-to-merge transitions through validated reporting commands.
- [ ] Implementation failure and blocked finalization are represented as distinct outcomes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `lib/claimManager.test.mjs` — assert finalization-phase state transitions and counters
- `cli/run-reporting.test.mjs` — assert the reporting CLIs accept finalization-phase transitions
- validation tests near the touched event/progress validators — assert bad finalization events are rejected

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs lib/claimManager.test.mjs cli/run-reporting.test.mjs lib/eventValidation.test.mjs lib/progressValidation.test.mjs
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
node cli/orc.mjs doctor
node cli/orc.mjs status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** A vague or overloaded state model will make later coordinator finalization logic brittle and can conflate blocked merge-time work with true task failure.
**Rollback:** Revert the state/reporting changes together and restore the simpler pre-finalization lifecycle until the coordinator loop is ready.
