---
ref: orch/task-159-notification-queue-ttl
epic: orch
status: todo
---

# Task 159 — Add TTL to Master Notification Queue

Independent.

## Scope

**In scope:**
- Stamp `ts: new Date().toISOString()` on every entry in `appendNotification` (one-liner, prerequisite for TTL to work on real entries)
- Extend `compactQueue` in `lib/masterNotifyQueue.mjs` to drop entries older than their TTL
- Consumed entries: TTL of 1 hour (drop silently)
- Unconsumed entries: TTL of 48 hours (drop with a `console.warn` per dropped entry)
- Tests for both the `ts` stamping and TTL behaviour in `lib/masterNotifyQueue.test.mjs`

**Out of scope:**
- Any change to `markConsumed`, `readAndMarkConsumed`, or `readPendingNotifications`
- Schema changes to `.orc-state/master-notify-queue.jsonl`
- Adding a cap on total entry count (a separate concern)

---

## Context

`lib/masterNotifyQueue.mjs` accumulates notification entries in `.orc-state/master-notify-queue.jsonl`. `compactQueue` runs on each coordinator tick and removes entries where `consumed === true`. However, it never removes entries based on age.

Two failure modes result from the missing TTL:

1. **Consumed entries pile up** between compact cycles if the coordinator restarts or ticks slowly. Each compaction removes them eventually, but if the file is never compacted (master offline for days) the file grows without bound.
2. **Unconsumed entries accumulate indefinitely** if master stays offline. When master reconnects it is flooded with stale notifications for tasks that completed days ago, with no way to tell which are recent.

The fix has two parts: (1) stamp `ts` in `appendNotification` so every entry carries an ISO timestamp from the moment it is written; (2) in `compactQueue`, apply an age-based filter using that `ts` field in addition to the existing consumed-entry filter.

**Why `appendNotification` must be touched:** production queue writers (`coordinator.mjs`, `mcp/handlers.mjs`) call `appendNotification` and do not populate `ts` themselves. Without stamping `ts` here, real notifications would never have a timestamp and the TTL logic would always fail-open (preserve everything), defeating the purpose.

### Current state

```js
// masterNotifyQueue.mjs — compactQueue
const compacted = lines.filter((line) => {
  const parsed = parseJsonLine(line);
  if (!parsed) return true;
  return parsed.consumed !== true;   // ← only criterion
});
```

### Desired state

```js
// masterNotifyQueue.mjs — compactQueue
const now = Date.now();
const CONSUMED_TTL_MS = 60 * 60 * 1000;        // 1 hour
const UNCONSUMED_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

const compacted = lines.filter((line) => {
  const parsed = parseJsonLine(line);
  if (!parsed) return true; // preserve malformed lines

  const ts = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : null;
  if (ts === null || isNaN(ts)) return true; // no ts → preserve

  const age = now - ts;
  if (parsed.consumed === true) return age < CONSUMED_TTL_MS;
  if (age >= UNCONSUMED_TTL_MS) {
    console.warn(`[master-notify-queue] dropping stale unconsumed notification seq=${parsed.seq} task=${parsed.task_ref}`);
    return false;
  }
  return true;
});
```

### Start here

- `lib/masterNotifyQueue.mjs` — `compactQueue` function (line 132)
- `lib/masterNotifyQueue.test.mjs` — existing test suite

**Affected files:**
- `lib/masterNotifyQueue.mjs` — stamp `ts` in `appendNotification`; extend `compactQueue`
- `lib/masterNotifyQueue.test.mjs` — add ts-stamping and TTL tests

---

## Goals

1. Must stamp `ts: new Date().toISOString()` on every entry written by `appendNotification` (caller-supplied `ts` is overridden).
2. Must drop consumed entries older than 1 hour during `compactQueue` without any log output.
3. Must drop unconsumed entries older than 48 hours during `compactQueue` with a `console.warn` per dropped entry including `seq` and `task_ref`.
4. Must preserve entries with no `ts` field or an unparseable `ts` value (fail-open).
5. Must preserve entries that are within their TTL window.
6. All existing `masterNotifyQueue.test.mjs` tests must continue to pass.

---

## Implementation

### Step 1 — Stamp `ts` in `appendNotification`

**File:** `lib/masterNotifyQueue.mjs`

In `appendNotification`, change the entry construction to always set `ts`:

```js
// Before:
const entry = { seq: nextSeq, consumed: false, ...notification };

// After:
const entry = { seq: nextSeq, consumed: false, ...notification, ts: new Date().toISOString() };
```

Placing `ts` last ensures it overrides any caller-supplied value, making the timestamp authoritative.

### Step 2 — Define TTL constants inside `compactQueue`

**File:** `lib/masterNotifyQueue.mjs`

At the top of `compactQueue`, after `const path = queuePath(stateDir)`:

```js
const now = Date.now();
const CONSUMED_TTL_MS = 60 * 60 * 1000;         // 1 h
const UNCONSUMED_TTL_MS = 48 * 60 * 60 * 1000;  // 48 h
```

### Step 3 — Replace the filter predicate

**File:** `lib/masterNotifyQueue.mjs`

Replace:
```js
const compacted = lines.filter((line) => {
  const parsed = parseJsonLine(line);
  if (!parsed) return true;
  return parsed.consumed !== true;
});
```

With:
```js
const compacted = lines.filter((line) => {
  const parsed = parseJsonLine(line);
  if (!parsed) return true;

  const ts = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : null;
  const age = (ts !== null && !isNaN(ts)) ? now - ts : null;

  if (parsed.consumed === true) {
    // drop consumed entries older than 1h; keep if no ts
    return age === null || age < CONSUMED_TTL_MS;
  }
  // unconsumed: drop after 48h with a warning
  if (age !== null && age >= UNCONSUMED_TTL_MS) {
    console.warn(
      `[master-notify-queue] dropping stale unconsumed notification seq=${parsed.seq ?? '?'} task=${parsed.task_ref ?? '?'}`,
    );
    return false;
  }
  return true;
});
```

Invariant: the `if (compacted.length === lines.length) return;` early-exit check must remain after the filter to avoid unnecessary file writes.

---

## Acceptance criteria

- [ ] `appendNotification` stamps `ts` as an ISO string on every written entry.
- [ ] A consumed entry with `ts` older than 1 hour is absent from the queue file after `compactQueue`.
- [ ] A consumed entry with `ts` less than 1 hour old is retained after `compactQueue`.
- [ ] An unconsumed entry with `ts` older than 48 hours is absent from the queue file after `compactQueue` and a `console.warn` is emitted.
- [ ] An unconsumed entry with `ts` less than 48 hours old is retained after `compactQueue`.
- [ ] Entries with no `ts` field are never dropped by TTL logic (backward compat with old entries).
- [ ] Entries with a malformed `ts` value are never dropped by TTL logic.
- [ ] All pre-existing `masterNotifyQueue.test.mjs` tests continue to pass.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/masterNotifyQueue.test.mjs`:

```js
it('appendNotification stamps ts on every written entry', () => { ... });

describe('compactQueue TTL', () => {
  it('drops consumed entries older than 1 hour', () => { ... });
  it('retains consumed entries younger than 1 hour', () => { ... });
  it('drops and warns on unconsumed entries older than 48 hours', () => { ... });
  it('retains unconsumed entries younger than 48 hours', () => { ... });
  it('retains entries with missing ts regardless of consumed state', () => { ... });
  it('retains entries with unparseable ts', () => { ... });
});
```

---

## Verification

```bash
npx vitest run lib/masterNotifyQueue.test.mjs
```

```bash
nvm use 24 && npm run build
nvm use 24 && npm test
```
