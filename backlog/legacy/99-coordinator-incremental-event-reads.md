# Task 99 — Coordinator: Incremental Event Log Reads to Replace Full Re-scan

Independent.

## Scope

**In scope:**
- `coordinator.mjs` — replace full `readEvents` re-scan on every tick with an incremental read of only new lines since `lastProcessedSeq`
- `lib/eventLog.mjs` — add `readEventsSince(logPath, afterSeq)` export that reads only lines with `seq > afterSeq`
- `lib/eventLog.test.mjs` — add tests for `readEventsSince`

**Out of scope:**
- `latestRunActivityMap` / `latestRunActivityDetailMap` — these may still need the full event set; evaluate and document the decision in Context
- Any schema, state, or CLI changes

---

## Context

In `coordinator.mjs` (lines 371–377), every tick where `currentSeq > lastProcessedSeq` calls:

```js
const events = readEvents(EVENTS_FILE);
```

`readEvents` parses and schema-validates every line in `events.jsonl` from the beginning.
On a long-running project the file grows unboundedly. A system running for weeks with 10,000+
events will re-parse all of them on every coordinator tick (default 5 s interval). This is
O(n) per tick with no upper bound.

`processTerminalRunEvents` only needs events where `seq > lastProcessedSeq`. The full scan is
only required because `latestRunActivityMap` and `latestRunActivityDetailMap` also consume the
events array for the run-activity nudge logic. That nudge logic looks at all active runs, not
just new events — so it does need a broader window, but not necessarily the entire history.

**Proposed approach:**
1. Add `readEventsSince(logPath, afterSeq)` — a forward scan that stops before returning lines
   with seq ≤ afterSeq (or reads only from the appropriate byte offset using a reverse scan to
   find the offset of `afterSeq`). Simple implementation: read all, filter. This is still O(n)
   but eliminates schema validation overhead for already-processed events.
2. For `processTerminalRunEvents`, pass only `newEvents` (seq > lastProcessedSeq).
3. For `latestRunActivityMap`, continue to pass the full set for now and document as a known
   follow-up (a separate windowed activity map is a larger refactor).

This is a pragmatic incremental improvement, not the full solution.

**Affected files:**
- `coordinator.mjs` — tick loop, event consumption
- `lib/eventLog.mjs` — new `readEventsSince` export
- `lib/eventLog.test.mjs` — new tests

---

## Goals

1. Must add `readEventsSince(logPath, afterSeq)` that returns only events with `seq > afterSeq`.
2. Must use `readEventsSince` in the coordinator tick for `processTerminalRunEvents` input.
3. Must document in a comment why `latestRunActivityMap` still receives the full event set.
4. Must not change any observable coordinator behaviour.
5. Must add unit tests for `readEventsSince` including the empty-result and boundary cases.

---

## Implementation

### Step 1 — Add `readEventsSince` to `eventLog.mjs`

**File:** `lib/eventLog.mjs`

```js
/**
 * Read events with seq strictly greater than afterSeq.
 * Returns an empty array when afterSeq >= highest seq in the file.
 * Still reads the full file but skips schema validation for already-seen events,
 * reducing overhead for the common case where only 1-2 new events exist.
 */
export function readEventsSince(logPath, afterSeq) {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  const results = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (typeof obj.seq === 'number' && obj.seq > afterSeq) {
        results.push(obj);
      }
    } catch { /* skip malformed lines */ }
  }
  return results;
}
```

### Step 2 — Use `readEventsSince` in coordinator tick

**File:** `coordinator.mjs`

Import:
```js
import { readEvents, readEventsSince, nextSeq } from './lib/eventLog.mjs';
```

In the tick loop, replace:
```js
const events = readEvents(EVENTS_FILE);
processTerminalRunEvents(events.filter(e => e.seq > lastProcessedSeq));
```

With:
```js
// Full event set still needed for run-activity nudge logic.
// processTerminalRunEvents only needs new events — use incremental read.
const allEvents   = readEvents(EVENTS_FILE);                    // for latestRunActivityMap
const newEvents   = readEventsSince(EVENTS_FILE, lastProcessedSeq); // for processTerminalRunEvents
processTerminalRunEvents(newEvents);
```

Add a comment above the `allEvents` line:
```js
// TODO(perf): latestRunActivityMap scans all events for nudge timing.
// A future task should window this to recent events only.
```

### Step 3 — Add tests

**File:** `lib/eventLog.test.mjs`

```js
describe('readEventsSince', () => {
  it('returns only events with seq > afterSeq', () => {
    writeFileSync(logPath, [
      JSON.stringify({ seq: 1, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }),
      JSON.stringify({ seq: 2, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }),
      JSON.stringify({ seq: 3, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }),
    ].join('\n'));
    const result = readEventsSince(logPath, 1);
    expect(result.map(e => e.seq)).toEqual([2, 3]);
  });

  it('returns empty array when afterSeq >= all seqs', () => {
    writeFileSync(logPath, JSON.stringify({ seq: 5, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }));
    expect(readEventsSince(logPath, 5)).toEqual([]);
    expect(readEventsSince(logPath, 99)).toEqual([]);
  });

  it('returns all events when afterSeq is 0', () => {
    writeFileSync(logPath, [
      JSON.stringify({ seq: 1, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }),
      JSON.stringify({ seq: 2, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }),
    ].join('\n'));
    expect(readEventsSince(logPath, 0)).toHaveLength(2);
  });

  it('returns empty array for missing file', () => {
    expect(readEventsSince('/nonexistent/events.jsonl', 0)).toEqual([]);
  });

  it('skips malformed lines silently', () => {
    writeFileSync(logPath, [
      JSON.stringify({ seq: 1, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }),
      'not-json',
      JSON.stringify({ seq: 3, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'c', agent_id: 'a' }),
    ].join('\n'));
    const result = readEventsSince(logPath, 0);
    expect(result.map(e => e.seq)).toEqual([1, 3]);
  });
});
```

---

## Acceptance criteria

- [ ] `readEventsSince(logPath, afterSeq)` is exported from `eventLog.mjs`.
- [ ] Returns only events with `seq > afterSeq`.
- [ ] Returns empty array for missing file or when afterSeq ≥ all seqs.
- [ ] Malformed lines are skipped silently (no throw).
- [ ] `processTerminalRunEvents` in coordinator receives only new events (seq > lastProcessedSeq).
- [ ] `latestRunActivityMap` still receives the full event set (documented with TODO comment).
- [ ] All 5 new unit tests pass.
- [ ] All existing `eventLog.test.mjs` tests still pass.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs lib/eventLog.test.mjs
```

---

## Verification

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** `readEventsSince` skips schema validation for all events (unlike `readEvents`). This means malformed events with `seq > lastProcessedSeq` would be silently skipped rather than throwing. The coordinator's existing error handling around `processTerminalRunEvents` should catch any downstream issues.

**Rollback:** `git restore coordinator.mjs lib/eventLog.mjs`
