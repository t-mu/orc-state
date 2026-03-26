---
ref: runtime-robustness/66-phase-aware-nudging
title: "Phase-aware coordinator nudging and status visibility"
status: todo
feature: runtime-robustness
task_type: implementation
priority: normal
depends_on:
  - runtime-robustness/65-task-mark-done-auto-spec-update
---

# Task 66 — Phase-Aware Coordinator Nudging and Status Visibility

Depends on Task 65 (phased workflow definition in AGENTS.md).

## Scope

**In scope:**
- Add `orc progress --phase=<name>` calls to AGENTS.md phased workflow as expected (not enforced) signals.
- Coordinator reads last phase event per run during `enforceInProgressLifecycle()`.
- Nudge messages are tailored to the current phase.
- `orc status` and warroom TUI show current phase per active run.

**Out of scope:**
- Making phase signals hard gates (they remain observability only).
- Changes to phase event schema or event types.
- Changes to nudge timing thresholds (use existing `RUN_INACTIVE_NUDGE_MS`).
- Adding new phase names beyond the five defined in the phased workflow.

---

## Context

### Current state

Workers can emit `orc progress --event=phase_started --phase=<name>` events. These events are written to the event store but not consumed anywhere:
- The coordinator sends generic nudge messages ("you seem inactive") regardless of what the worker is doing.
- `orc status` and the warroom TUI show claim state (`claimed`, `in_progress`) but not which phase the worker is in.
- There is no way to distinguish a worker stuck in exploration from one stuck waiting for reviewers.

### Desired state

Workers emit phase signals at each phase boundary. The coordinator reads the last phase event per run and uses it to send targeted nudge messages. `orc status` and the warroom show the current phase per active run.

Phase nudge mapping:

| Last phase | Stall threshold | Nudge message |
|-----------|----------------|---------------|
| (none) | >10 min | "Have you started exploring the task spec?" |
| explore | >15 min | "Have you started implementing?" |
| implement | >20 min | "Are tests passing? Run npm test." |
| review | >15 min | "Have reviewers responded? Check orc review-read." |
| complete | >10 min | "Run orc run-work-complete to hand off." |

### Start here

- `coordinator.ts` — `enforceInProgressLifecycle()` function (nudge logic)
- `lib/runActivity.ts` — `latestRunActivityMap()` (event scanning per run)
- `lib/statusView.ts` — status rendering
- `lib/tui/status.ts` — warroom TUI status model

**Affected files:**
- `AGENTS.md` — add `orc progress --phase=<name>` calls to each phase
- `coordinator.ts` — phase-aware nudge in `enforceInProgressLifecycle()`
- `lib/runActivity.ts` — extract last phase per run from events
- `lib/statusView.ts` — include phase in status output
- `lib/tui/status.ts` — include phase in warroom model

---

## Goals

1. Must add `orc progress --phase=explore|implement|review|complete` to AGENTS.md at each phase boundary as expected signals.
2. Must read last `phase_started` event per run in coordinator nudge logic.
3. Must tailor nudge messages based on current phase (see table above).
4. Must fall back to generic nudge when no phase event exists.
5. Must show current phase per active run in `orc status --json` output.
6. Must show current phase per active run in warroom TUI.
7. Must NOT make phase signals hard gates — missing phase events do NOT block the workflow.

---

## Implementation

### Step 1 — Add phase signals to AGENTS.md

**File:** `AGENTS.md`

In each phase section (from Task 65's phased workflow), add the phase signal as the first action. Use imperative language:

```markdown
### Phase 1 — Explore
Signal phase start: `orc progress --event=phase_started --phase=explore --run-id=<run_id> --agent-id=<agent_id>`
Read the full task spec. Identify all affected files.
...

### Phase 2 — Implement
Signal phase start: `orc progress --event=phase_started --phase=implement --run-id=<run_id> --agent-id=<agent_id>`
Write code changes. Write tests for all new logic.
...
```

### Step 2 — Extract last phase per run from events

**File:** `lib/runActivity.ts`

Add a function or extend `latestRunActivityMap()` to return the last `phase_started` event's `phase` field per run_id. Return `null` if no phase event exists.

### Step 3 — Phase-aware nudge messages

**File:** `coordinator.ts` — `enforceInProgressLifecycle()`

When building a nudge message for a stalled run, look up the current phase from step 2. Select the nudge message from the phase mapping table. Fall back to the existing generic nudge when phase is `null`.

### Step 4 — Surface phase in status output

**File:** `lib/statusView.ts`

Add `current_phase: string | null` to the active run entries in the JSON status output.

**File:** `lib/tui/status.ts`

Add phase to the warroom TUI run display. Show as a short label next to the run state, e.g., `in_progress (implement)`.

---

## Acceptance criteria

- [ ] AGENTS.md includes `orc progress --phase=<name>` at each phase boundary.
- [ ] Coordinator reads last phase event per run during nudge evaluation.
- [ ] Nudge messages differ based on current phase (at least 3 distinct messages).
- [ ] Generic nudge is sent when no phase event exists for a run.
- [ ] `orc status --json` includes `current_phase` per active run.
- [ ] Warroom TUI shows current phase per active run.
- [ ] Missing phase signals do NOT block any workflow gate.
- [ ] `npm test` passes.

---

## Tests

Add to `coordinator.test.ts` or `e2e/coordinatorPolicies.e2e.test.ts`:

```typescript
it('sends phase-aware nudge when worker is stalled in explore', () => { ... });
it('sends phase-aware nudge when worker is stalled in implement', () => { ... });
it('sends generic nudge when no phase event exists', () => { ... });
```

Add to `lib/statusView.test.ts`:

```typescript
it('includes current_phase in active run status', () => { ... });
```

---

## Verification

```bash
npx vitest run coordinator.test.ts lib/statusView.test.ts
```

```bash
nvm use 24 && npm test
```
