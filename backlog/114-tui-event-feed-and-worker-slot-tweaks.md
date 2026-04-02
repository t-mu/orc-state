---
ref: publish/114-tui-event-feed-and-worker-slot-tweaks
feature: publish
priority: normal
status: done
---

# Task 114 — TUI Event Feed and Worker Slot Display Tweaks

Independent.

## Scope

**In scope:**
- Event feed: replace run_id with agent_id + event + task slug
- Worker slot: split "idle" into separate "activity" and "heartbeat" indicators
- Add `agent_id` to `TuiRecentEvent` interface
- Heartbeat interval: change background loop from `sleep 270` to `sleep 60` in worker bootstrap
- Update any stall detection thresholds calibrated to the old 270s interval

**Out of scope:**
- Changing the worker slot provider/model display (keep as-is)
- Modifying sprite rendering or worker grid layout
- Changing the RunsTable or FailureAlert components
- Modifying the event log schema or SQLite storage

---

## Context

The `orc watch` TUI has two readability issues:

1. The event feed shows `run_started run-20260330101353-7e5b` — the run_id is meaningless to a human observer. The agent_id and task slug provide immediate context.
2. The worker slot shows `idle: 267s` which is misleading — it represents "time since last activity" not "how long the worker has been idle." Additionally, a single value conflates work activity with heartbeat keep-alives, making it hard to distinguish "working quietly" from "stuck."

The heartbeat interval of 270s (4.5 min) also causes confusion — a healthy worker can show large idle values. Reducing to 60s keeps the heartbeat indicator fresh.

### Current state

Event feed (EventFeed.tsx line 16):
```tsx
{event.event ?? 'unknown'} {event.run_id ?? event.task_ref ?? ''}
```

Worker slot (WorkerSlot.tsx line 24):
```tsx
age: {formatSeconds(slot.age_seconds)} idle: {formatSeconds(slot.idle_seconds)}
```

Worker bootstrap heartbeat loop: `sleep 270`

### Desired state

Event feed:
```
orc-1 run_started 111-fix-package-json
orc-1 phase_started:implement
orc-2 run_finished 112-fix-readme
      session_started
```

Worker slot:
```
age: 120s activity: 12s heartbeat: 48s
```

Worker bootstrap heartbeat loop: `sleep 60`

### Start here

- `lib/tui/EventFeed.tsx` — event feed rendering
- `lib/tui/WorkerSlot.tsx` — worker slot rendering
- `lib/tui/status.ts` — TuiRecentEvent interface and WorkerSlotViewModel
- `templates/worker-bootstrap-v2.txt` — heartbeat interval

**Affected files:**
- `lib/tui/EventFeed.tsx` — new display format
- `lib/tui/WorkerSlot.tsx` — split idle into activity + heartbeat
- `lib/tui/status.ts` — add `agent_id` to `TuiRecentEvent`, add `heartbeat_seconds` to `WorkerSlotViewModel`
- `lib/statusView.ts` — compute separate activity and heartbeat values
- `templates/worker-bootstrap-v2.txt` — change `sleep 270` to `sleep 60`
- `AGENTS.md` — update heartbeat interval references if any mention 270s
- Stall detection thresholds in `lib/constants.ts` or `coordinator.ts` if calibrated to 270s

---

## Goals

1. Must display event feed as `<agent_id> <event> <task_slug>` with graceful omission of missing fields.
2. Must strip feature prefix from task_ref for display (e.g. `publish/111-fix-package-json` → `111-fix-package-json`).
3. Must split the worker slot "idle" line into separate "activity" and "heartbeat" indicators.
4. Must change the worker bootstrap heartbeat interval from 270s to 60s.
5. Must update any stall detection thresholds that depend on the old heartbeat interval.
6. Must pass `npm test`.

---

## Implementation

### Step 1 — Add agent_id to TuiRecentEvent

**File:** `lib/tui/status.ts`

Add `agent_id` to the `TuiRecentEvent` interface:

```ts
export interface TuiRecentEvent {
  seq?: number;
  ts?: string;
  event?: string;
  run_id?: string | null;
  task_ref?: string | null;
  agent_id?: string | null;
}
```

### Step 2 — Update EventFeed display

**File:** `lib/tui/EventFeed.tsx`

Replace the event line rendering:

```tsx
<Text key={...} dimColor>
  {event.agent_id ? `${event.agent_id} ` : '  '}{event.event ?? 'unknown'}{taskSlug ? ` ${taskSlug}` : ''}
</Text>
```

Where `taskSlug` strips the feature prefix:
```ts
const taskSlug = event.task_ref?.split('/').slice(1).join('/') ?? '';
```

### Step 3 — Add heartbeat_seconds to WorkerSlotViewModel

**File:** `lib/tui/status.ts`

Add `heartbeat_seconds: number | null` to `WorkerSlotViewModel`.

### Step 4 — Compute separate activity and heartbeat values

**File:** `lib/statusView.ts`

The current `idle_seconds` uses a combined anchor (activity ?? heartbeat ?? started_at). Split into:
- `activity_seconds`: time since last non-heartbeat event for this run
- `heartbeat_seconds`: time since `last_heartbeat_at` on the claim

### Step 5 — Update WorkerSlot display

**File:** `lib/tui/WorkerSlot.tsx`

Replace line 24:
```tsx
<Text dimColor>
  age: {formatSeconds(slot.age_seconds)} activity: {formatSeconds(slot.activity_seconds)} heartbeat: {formatSeconds(slot.heartbeat_seconds)}
</Text>
```

### Step 6 — Change heartbeat interval to 60s

**File:** `templates/worker-bootstrap-v2.txt`

Change all occurrences of `sleep 270` to `sleep 60`.

### Step 7 — Update stall detection thresholds

Search for any thresholds calibrated to the 270s interval in `lib/constants.ts`, `coordinator.ts`, or configuration defaults. Adjust if needed — e.g. if a "stale heartbeat" threshold assumes 270s intervals, it may need tightening.

Also update `AGENTS.md` if it mentions the 270s interval or 4.5-minute cadence.

---

## Acceptance criteria

- [ ] Event feed shows `<agent_id> <event> <task_slug>` format.
- [ ] Task slug has feature prefix stripped.
- [ ] Events without agent_id render gracefully (whitespace padding).
- [ ] Worker slot shows separate `activity:` and `heartbeat:` indicators.
- [ ] No "idle" label remains in the worker slot.
- [ ] Worker bootstrap heartbeat loop uses `sleep 60`.
- [ ] Stall detection thresholds are consistent with the new 60s interval.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Update `lib/tui/App.test.tsx` if it asserts on event feed or worker slot output format.

Update `lib/tui/OrcSprite.test.tsx` or `WorkerSlot` tests if they assert on the "idle" label.

```ts
it('event feed shows agent_id and task slug instead of run_id');
it('worker slot shows activity and heartbeat separately');
```

---

## Verification

```bash
# Check event feed format
grep -n 'run_id' lib/tui/EventFeed.tsx
# Expected: no direct run_id display

# Check worker slot labels
grep -n 'idle' lib/tui/WorkerSlot.tsx
# Expected: no "idle" label

# Check heartbeat interval
grep 'sleep 60' templates/worker-bootstrap-v2.txt
# Expected: matches

# Full suite
nvm use 24 && npm test
```
