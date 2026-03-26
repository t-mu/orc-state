---
ref: runtime-robustness/67-phase-visibility-in-status-and-tui
title: "Surface current phase in orc status and warroom TUI"
status: done
feature: runtime-robustness
task_type: implementation
priority: normal
depends_on:
  - runtime-robustness/66-phase-aware-nudging
---

# Task 67 — Surface Current Phase in orc status and Warroom TUI

Depends on Task 66 (phase extraction function in `lib/runActivity.ts`).

## Scope

**In scope:**
- `orc status --json` includes `current_phase` per active run.
- `orc status` human-readable output shows phase next to run state.
- Warroom TUI shows current phase per active run.

**Out of scope:**
- Phase extraction logic (done in Task 66).
- Coordinator nudge logic (done in Task 66).
- Phase history or timeline views.

---

## Context

### Current state

Task 66 adds `latestRunPhaseMap()` to extract the last phase per run from events. The coordinator uses this for nudging. However, the phase data is not visible to operators — `orc status` and the warroom TUI only show claim state (`claimed`, `in_progress`) and finalization state.

### Desired state

`orc status --json` includes `current_phase: string | null` in each active run entry. The human-readable output shows phase as a label, e.g., `in_progress (implement)`. The warroom TUI includes phase in the run display.

### Start here

- `lib/runActivity.ts` — `latestRunPhaseMap()` (from Task 66)
- `lib/statusView.ts` — status rendering, `buildStatusJson()`
- `lib/tui/status.ts` — warroom TUI status model

**Affected files:**
- `lib/statusView.ts` — add `current_phase` to active run entries
- `lib/tui/status.ts` — add phase to warroom model and display
- `lib/tui/Header.tsx` or run list component — render phase label

---

## Goals

1. Must include `current_phase: string | null` in `orc status --json` for each active run.
2. Must show phase label in human-readable `orc status` output next to run state.
3. Must show phase in warroom TUI run entries.
4. Must display `null` / no label when no phase event exists for a run.
5. Must reuse `latestRunPhaseMap()` from Task 66 — do NOT reimplement phase extraction.

---

## Implementation

### Step 1 — Add phase to status JSON output

**File:** `lib/statusView.ts`

In the function that builds active run entries:
1. Import `latestRunPhaseMap` from `./runActivity.ts`
2. Call it with the events list (already available in scope)
3. Add `current_phase: phaseMap.get(run_id) ?? null` to each active run entry

### Step 2 — Add phase to human-readable output

**File:** `lib/statusView.ts`

In the text rendering section for active runs, append the phase label:
```
  run-abc123  orc-1  proj/fix-bug  in_progress (implement)  idle=5m
```

### Step 3 — Add phase to warroom TUI

**File:** `lib/tui/status.ts`

Add `current_phase: string | null` to the run status interface. Populate from `latestRunPhaseMap()`.

**File:** `lib/tui/Header.tsx` or relevant run list component

Render phase next to run state label.

---

## Acceptance criteria

- [ ] `orc status --json` includes `current_phase` per active run.
- [ ] `orc status` human-readable output shows phase label.
- [ ] Warroom TUI shows phase per active run.
- [ ] Displays no phase label when no phase event exists.
- [ ] Reuses `latestRunPhaseMap()` from Task 66.
- [ ] `npm test` passes.

---

## Tests

Add to `lib/statusView.test.ts`:

```typescript
it('includes current_phase in active run JSON status', () => { ... });
it('shows null phase when no phase events exist', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/statusView.test.ts lib/tui/status.test.ts
```

```bash
nvm use 24 && npm test
```
