---
ref: runtime-robustness/66-phase-aware-nudging
title: "Phase-aware coordinator nudging"
status: done
feature: runtime-robustness
task_type: implementation
priority: normal
depends_on:
  - runtime-robustness/65-task-mark-done-auto-spec-update
---

# Task 66 — Phase-Aware Coordinator Nudging

Depends on Task 65 (phased workflow definition in AGENTS.md).

## Scope

**In scope:**
- Add `orc progress --phase=<name>` calls to AGENTS.md phased workflow as expected (not enforced) signals.
- Add a function to extract the last phase per run from the event store.
- Coordinator reads last phase event per run during `enforceInProgressLifecycle()`.
- Nudge messages are tailored to the current phase.

**Out of scope:**
- Surfacing phase in `orc status`, warroom TUI, or any UI (separate task 67).
- Making phase signals hard gates (they remain observability only).
- Changes to phase event schema or event types.
- Changes to nudge timing thresholds (use existing `RUN_INACTIVE_NUDGE_MS`).

---

## Context

### Current state

Workers can emit `orc progress --event=phase_started --phase=<name>` events. These events are written to the event store but the coordinator does not read them. The coordinator sends generic nudge messages ("you seem inactive") regardless of what phase the worker is in. There is no way to distinguish a worker stuck in exploration from one stuck waiting for reviewers.

### Desired state

Workers emit phase signals at each phase boundary. The coordinator reads the last phase event per run and uses it to send targeted nudge messages. Falls back to generic nudge when no phase event exists.

Phase nudge mapping:

| Last phase | Nudge message |
|-----------|---------------|
| (none) | "Have you started exploring the task spec?" |
| explore | "Have you started implementing?" |
| implement | "Are tests passing? Run npm test." |
| review | "Have reviewers responded? Check orc review-read." |
| complete | "Run orc run-work-complete to hand off." |

### Start here

- `coordinator.ts` — `enforceInProgressLifecycle()` function (nudge logic)
- `lib/runActivity.ts` — `latestRunActivityMap()` (event scanning per run)

**Affected files:**
- `AGENTS.md` — add `orc progress --phase=<name>` calls to each phase
- `lib/runActivity.ts` — add function to extract last phase per run from events
- `coordinator.ts` — use phase in `enforceInProgressLifecycle()` nudge messages

---

## Goals

1. Must add `orc progress --phase=explore|implement|review|complete` to AGENTS.md at each phase boundary as expected signals.
2. Must add a function to extract the last `phase_started` event's `phase` field per run_id from the event store. Return `null` if no phase event exists.
3. Must tailor nudge messages based on current phase (see table above).
4. Must fall back to generic nudge when no phase event exists for a run.
5. Must NOT make phase signals hard gates — missing phase events do NOT block the workflow.

---

## Implementation

### Step 1 — Add phase signals to AGENTS.md

**File:** `AGENTS.md`

In each phase section (from Task 65's phased workflow), add the phase signal as the first action. Use imperative language:

```markdown
### Phase 1 — Explore
Signal phase start: `orc progress --event=phase_started --phase=explore --run-id=<run_id> --agent-id=<agent_id>`
Read the full task spec. Identify all affected files.

### Phase 2 — Implement
Signal phase start: `orc progress --event=phase_started --phase=implement --run-id=<run_id> --agent-id=<agent_id>`
Write code changes. Write tests for all new logic.

### Phase 3 — Review
Signal phase start: `orc progress --event=phase_started --phase=review --run-id=<run_id> --agent-id=<agent_id>`
Commit your changes, spawn reviewers, address findings.

### Phase 4 — Complete
Signal phase start: `orc progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=<agent_id>`
Mark done, rebase, signal coordinator.
```

### Step 2 — Extract last phase per run from events

**File:** `lib/runActivity.ts`

Add a function `latestRunPhaseMap(events: OrcEvent[]): Map<string, string | null>` that scans events for `phase_started` entries and returns a map of `run_id → last phase name`. Return `null` for runs with no phase events.

### Step 3 — Phase-aware nudge messages

**File:** `coordinator.ts` — `enforceInProgressLifecycle()`

When building a nudge message for a stalled run:
1. Look up the current phase from `latestRunPhaseMap()`
2. Select the nudge message from the phase mapping table
3. Fall back to the existing generic nudge when phase is `null`

---

## Acceptance criteria

- [ ] AGENTS.md includes `orc progress --phase=<name>` at each phase boundary.
- [ ] `latestRunPhaseMap()` correctly extracts last phase per run from events.
- [ ] Coordinator nudge messages differ based on current phase (at least 3 distinct messages).
- [ ] Generic nudge is sent when no phase event exists for a run.
- [ ] Missing phase signals do NOT block any workflow gate.
- [ ] `npm test` passes.

---

## Tests

Add to `lib/runActivity.test.ts`:

```typescript
it('returns last phase per run from phase_started events', () => { ... });
it('returns null for runs with no phase events', () => { ... });
it('uses latest phase when multiple phase events exist for a run', () => { ... });
```

Add to `coordinator.test.ts` or `e2e/coordinatorPolicies.e2e.test.ts`:

```typescript
it('sends phase-aware nudge when worker is stalled in explore', () => { ... });
it('sends phase-aware nudge when worker is stalled in implement', () => { ... });
it('sends generic nudge when no phase event exists', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/runActivity.test.ts coordinator.test.ts
```

```bash
nvm use 24 && npm test
```
