---
ref: publish/124-tui-phase-wizard
feature: publish
priority: normal
status: done
---

# Task 124 — Add Phase Wizard to TUI Worker Cards

Independent.

## Scope

**In scope:**
- Add a `runPhaseHistory()` function to `lib/runActivity.ts` that returns all phase timestamps per run
- Add a `PhaseEntry` type and `phases` array to `WorkerSlotViewModel` in `lib/tui/status.ts`
- Create a `PhaseWizard` Ink component in `lib/tui/PhaseWizard.tsx`
- Integrate `PhaseWizard` into `WorkerSlot.tsx`, replacing the `run_state (phase)` line
- Add a duration formatter (`1h 2m 30s` style)
- Add tests for `runPhaseHistory()`, phase array construction, and the `PhaseWizard` component

**Out of scope:**
- Changing card width or overall card layout beyond the phase display line
- Removing the existing `age/activity/heartbeat` timing line
- Changing the sprite system or animation
- Changing `RunsTable`, `EventFeed`, `Header`, or other TUI components
- Changing event schema or adding new event types
- Phase-specific stale thresholds (stale is heartbeat-relative only)

---

## Context

### Current state

Worker cards in the TUI (`orc watch`) show the current phase as a parenthetical
suffix on a single dimmed line:

```
in_progress (review)
```

Only the current phase is visible. There is no indication of which phases are
done, how long each took, or whether the active phase is stale. The user must
check the event log to understand progression.

Phase data flows through `latestRunPhaseMap()` in `lib/runActivity.ts`, which
returns only the *latest* phase per run. `statusView.ts` (line 287) calls this
and stores the result in `current_phase` on each claim. The `WorkerSlot.tsx`
component renders it at line 22.

### Desired state

Worker cards display a vertical phase wizard showing all five phases with
graphical indicators and durations:

```
● explore       1m 12s
● implement     8m 45s
◐ review
○ complete
○ finalize
```

Indicators:
- `●` green — done (phase completed, duration shown)
- `◐` white — active (current phase, heartbeat fresh)
- `◐` yellow — stale (current phase, heartbeat > 5min old)
- `✗` red — error/blocked (run failed or blocked)
- `○` dim — pending (not yet started)

Duration format: `1h 2m 30s` with spaces between units, leading zero units
dropped (e.g. `2m 30s` not `0h 2m 30s`). Active and pending phases show no
duration.

### Start here

- `lib/tui/WorkerSlot.tsx` — current card rendering (33 lines)
- `lib/tui/status.ts` — `WorkerSlotViewModel` interface and `buildWorkerSlotViewModels()`
- `lib/runActivity.ts` — `latestRunPhaseMap()` (only returns latest phase)
- `lib/statusView.ts` — `buildActiveClaimMetrics()` wires phase data into claims

**Affected files:**
- `lib/runActivity.ts` — add `runPhaseHistory()` function
- `lib/tui/status.ts` — add `PhaseEntry` type, extend `WorkerSlotViewModel`, update `buildWorkerSlotViewModels()`
- `lib/tui/PhaseWizard.tsx` — new component (vertical phase list)
- `lib/tui/WorkerSlot.tsx` — integrate `PhaseWizard`, add duration formatter
- `lib/statusView.ts` — call `runPhaseHistory()` and pass through to TUI status

---

## Goals

1. Must add `runPhaseHistory()` to `lib/runActivity.ts` returning all `phase_started` events per run with timestamps
2. Must compute phase durations from consecutive `phase_started` timestamps
3. Must add a `phases` array to `WorkerSlotViewModel` with state (`done`, `active`, `stale`, `error`, `pending`) and `duration_seconds`
4. Must render a vertical phase wizard in `PhaseWizard.tsx` with correct indicators and colors
5. Must detect stale phases using `heartbeat_seconds` (threshold: > 300s / 5min)
6. Must format durations as `1h 2m 30s` (space-separated, no leading zero units)
7. Must not change card width, sprite system, or other TUI components

---

## Implementation

### Step 1 — Add `runPhaseHistory()` to `lib/runActivity.ts`

**File:** `lib/runActivity.ts`

Add a new exported function that collects all `phase_started` events per run,
ordered by timestamp:

```typescript
export interface RunPhaseEntry {
  phase: string;
  started_at: string; // ISO timestamp
}

export function runPhaseHistory(events: OrcEvent[] | null | undefined): Map<string, RunPhaseEntry[]> {
  const result = new Map<string, RunPhaseEntry[]>();
  for (const ev of events ?? []) {
    const e = ev as { run_id?: string; ts?: string; event?: string; phase?: string; payload?: { phase?: string } };
    if (!e?.run_id || !e.ts) continue;
    const phase = e.phase ?? e.payload?.phase;
    if (e.event !== 'phase_started' || typeof phase !== 'string' || phase.length === 0) continue;
    let list = result.get(e.run_id);
    if (!list) { list = []; result.set(e.run_id, list); }
    list.push({ phase, started_at: e.ts });
  }
  // Sort each run's phases by timestamp
  for (const list of result.values()) {
    list.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  }
  return result;
}
```

### Step 2 — Wire phase history through `statusView.ts`

**File:** `lib/statusView.ts`

Import `runPhaseHistory` alongside `latestRunPhaseMap`. Call it with `allEvents`
and pass the resulting map into the TUI status object so `buildWorkerSlotViewModels`
can access it. Add a `phase_history` field to the claims or status structure that
`status.ts` reads.

### Step 3 — Add `PhaseEntry` type and extend `WorkerSlotViewModel`

**File:** `lib/tui/status.ts`

```typescript
export interface PhaseEntry {
  name: string;
  state: 'done' | 'active' | 'stale' | 'error' | 'pending';
  duration_seconds: number | null;
}
```

Replace `current_phase: string | null` with `phases: PhaseEntry[]` in
`WorkerSlotViewModel`.

Update `buildWorkerSlotViewModels()` to build the `phases` array using:
- Canonical phase list: `['explore', 'implement', 'review', 'complete', 'finalize']`
- Phase history from step 2 for timestamps and ordering
- `heartbeat_seconds` for stale detection (> 300 = stale)
- `run_state` for error detection (`blocked` or `failed` = error on active phase)

Logic for each canonical phase:
- Phase appears in history and a later phase also exists → `done`, duration = next phase start - this phase start
- Phase appears in history and is the last phase → `active` (or `stale` if heartbeat > 300s, or `error` if run_state is blocked/failed)
- Phase does not appear in history → `pending`

### Step 4 — Create `PhaseWizard` component

**File:** `lib/tui/PhaseWizard.tsx` (new)

```tsx
import { Text, Box } from 'ink';
import type { PhaseEntry } from './status.ts';

const INDICATOR: Record<PhaseEntry['state'], { symbol: string; color?: string; dimColor?: boolean }> = {
  done:    { symbol: '●', color: 'green' },
  active:  { symbol: '◐', color: 'white' },
  stale:   { symbol: '◐', color: 'yellow' },
  error:   { symbol: '✗', color: 'red' },
  pending: { symbol: '○', dimColor: true },
};

export function PhaseWizard({ phases }: { phases: PhaseEntry[] }) {
  return (
    <Box flexDirection="column">
      {phases.map((p) => {
        const ind = INDICATOR[p.state];
        return (
          <Box key={p.name}>
            <Text color={ind.color} dimColor={ind.dimColor}>{ind.symbol} {p.name.padEnd(12)}</Text>
            {p.duration_seconds != null && (
              <Text dimColor>{formatDuration(p.duration_seconds)}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
```

### Step 5 — Add duration formatter

**File:** `lib/tui/PhaseWizard.tsx` (same file)

```typescript
export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
```

### Step 6 — Integrate into `WorkerSlot.tsx`

**File:** `lib/tui/WorkerSlot.tsx`

Replace line 22:
```tsx
<Text dimColor>{slot.run_state ? `${slot.run_state}${slot.current_phase ? ` (${slot.current_phase})` : ''}` : ''}</Text>
```

With:
```tsx
{slot.phases.length > 0 && <PhaseWizard phases={slot.phases} />}
```

Import `PhaseWizard` from `./PhaseWizard.tsx`.

### Step 7 — Handle `current_phase` removal in `RunsTable`

**File:** `lib/tui/RunsTable.tsx` (if it references `current_phase`)

Check if `RunsTable` uses `current_phase` from `TuiClaim`. If so, leave
`TuiClaim.current_phase` intact (it's a separate type from `WorkerSlotViewModel`).
Only change the view model, not the claim type.

---

## Acceptance criteria

- [ ] `runPhaseHistory()` returns all phase_started events per run, sorted by timestamp
- [ ] `WorkerSlotViewModel.phases` contains entries for all 5 canonical phases
- [ ] Done phases show `●` green with duration in `Xh Ym Zs` format
- [ ] Active phase shows `◐` white when heartbeat is fresh (< 300s)
- [ ] Active phase shows `◐` yellow when heartbeat is stale (>= 300s)
- [ ] Error/blocked phase shows `✗` red
- [ ] Pending phases show `○` dim with no duration
- [ ] Duration drops leading zero units (`2m 30s` not `0h 2m 30s`)
- [ ] Phase wizard renders vertically in worker card
- [ ] Cards without an active run show no phase wizard
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/runActivity.test.ts`:

```typescript
describe('runPhaseHistory', () => {
  it('returns empty map for no events', () => { ... });
  it('collects all phase_started events per run sorted by timestamp', () => { ... });
  it('handles multiple runs independently', () => { ... });
});
```

Add to `lib/tui/status.test.ts` (or new file):

```typescript
describe('phase array construction', () => {
  it('marks completed phases as done with correct duration', () => { ... });
  it('marks latest phase as active when heartbeat fresh', () => { ... });
  it('marks latest phase as stale when heartbeat > 300s', () => { ... });
  it('marks active phase as error when run_state is blocked', () => { ... });
  it('marks unstarted phases as pending', () => { ... });
  it('returns empty array when no run is active', () => { ... });
});
```

Add to new `lib/tui/PhaseWizard.test.tsx`:

```typescript
describe('formatDuration', () => {
  it('formats seconds only', () => expect(formatDuration(45)).toBe('45s'));
  it('formats minutes and seconds', () => expect(formatDuration(150)).toBe('2m 30s'));
  it('formats hours minutes seconds', () => expect(formatDuration(3661)).toBe('1h 1m 1s'));
  it('drops zero hours', () => expect(formatDuration(60)).toBe('1m 0s'));
});
```

---

## Verification

```bash
# Targeted tests
npx vitest run lib/runActivity.test.ts
npx vitest run lib/tui/
```

```bash
# Full suite
nvm use 24 && npm test
```

```bash
# Visual verification
orc watch
```
