# Task 30 — Fix Event Timestamp Coercion in Response Ingestion

Critical correctness fix. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Harden the three places in `coordinator.mjs::recordAdapterResponseEvents` where
  `ts: ev.ts ?? new Date().toISOString()` is used for event construction
- Replace with a validated coercion that falls back to wall-clock time if the agent-provided
  timestamp is not a valid ISO date-time string
- Add tests covering the literal-placeholder and malformed-timestamp scenarios

**Out of scope:**
- Changing `lib/eventLog.mjs`, `lib/ajvFactory.mjs`, or `lib/eventValidation.mjs`
- Changing nudge templates (the `<ISO8601>` placeholders remain in the templates; the fix
  is on the ingestion side)
- Changing how `startRun`, `heartbeat`, `finishRun` construct their own events (they always
  use `new Date().toISOString()` directly — already correct)

---

## Context

`coordinator.mjs::recordAdapterResponseEvents` processes `[ORC_EVENT]` lines extracted from
agent API responses. For each event it constructs an event object using the agent-provided
`ev.ts` field:

```js
// Three locations in coordinator.mjs (catch block, default branch, no-run-context branch):
appendSequencedEvent(STATE_DIR, {
  ts: ev.ts ?? new Date().toISOString(),
  ...ev,
  ...overrides,
});
```

The nudge messages sent to agents contain the literal string `<ISO8601>` as a placeholder:

```
[ORC_EVENT] {"event":"run_started","run_id":"run-abc","agent_id":"bob","ts":"<ISO8601>"}
```

If an agent reproduces this line verbatim, `ev.ts = "<ISO8601>"`. Since `"<ISO8601>"` is
truthy, the `??` operator does not fall back, and `appendEvent` receives `ts: "<ISO8601>"`.

`ajvFactory.mjs` registers a custom `date-time` format validator:
```js
validate: (value) => Number.isFinite(new Date(value).getTime())
```

`new Date("<ISO8601>").getTime()` returns `NaN`, so `Number.isFinite(NaN)` is `false`,
and `appendEvent` throws `"event validation failed: /ts ..."`.

In the `default` case (and in the `catch` fallback), this throw propagates out of
`recordAdapterResponseEvents` uncaught, causing the entire tick-level API call handler to
abort with a logged error. The run state machine may still be partially advanced (e.g., if
`run_started` succeeded before the raw-event append threw), but any subsequent events in the
same response are silently dropped.

**Affected files:**
- `coordinator.mjs` — 3 call-sites in `recordAdapterResponseEvents`
- `e2e/orchestrationLifecycle.e2e.test.mjs` — new test

---

## Goals

1. Must coerce `ev.ts` to a valid ISO timestamp at all three event-construction sites
2. Must fall back to `new Date().toISOString()` when `ev.ts` is absent, empty, or not a
   valid date string (including the literal `<ISO8601>`)
3. Must not alter the timestamp when the agent provides a valid ISO 8601 string
4. Must not change how `startRun`, `heartbeat`, `finishRun` construct coordinator-owned events
5. Must have a test where a response containing `"ts":"<ISO8601>"` results in a valid event
   being written with a well-formed timestamp
6. Must have a test where a response containing a valid ISO timestamp preserves that timestamp

---

## Implementation

### Step 1 — Define a timestamp coercion helper

**File:** `coordinator.mjs`

Add a small helper at the top of the file (near other helper functions like `log`, `emit`):

```js
/** Coerce an agent-provided timestamp to a valid ISO string, or fall back to now. */
function coerceTs(ts) {
  if (ts && typeof ts === 'string' && Number.isFinite(new Date(ts).getTime())) return ts;
  return new Date().toISOString();
}
```

### Step 2 — Replace `ts` construction at all three sites in `recordAdapterResponseEvents`

**File:** `coordinator.mjs`

There are three places where `{ ts: ev.ts ?? new Date().toISOString(), ...ev, ... }` is
constructed. Replace each with `{ ts: coerceTs(ev.ts), ...ev, ... }`.

**Site A** — inside the `try/catch` block, in the `default:` case (raw event append):

```js
// Before:
appendSequencedEvent(STATE_DIR, {
  ts: ev.ts ?? new Date().toISOString(),
  ...ev,
  run_id: effectiveRunId,
  task_ref: effectiveTaskRef ?? undefined,
  agent_id: effectiveAgentId,
  actor_type: ev.actor_type ?? 'agent',
  actor_id: ev.actor_id ?? effectiveAgentId,
});

// After:
appendSequencedEvent(STATE_DIR, {
  ts: coerceTs(ev.ts),
  ...ev,
  run_id: effectiveRunId,
  task_ref: effectiveTaskRef ?? undefined,
  agent_id: effectiveAgentId,
  actor_type: ev.actor_type ?? 'agent',
  actor_id: ev.actor_id ?? effectiveAgentId,
});
```

**Site B** — inside the `catch` block (fallback raw event append after state-machine error):

```js
// Before:
appendSequencedEvent(STATE_DIR, {
  ts: ev.ts ?? new Date().toISOString(),
  ...ev,
  ...
});

// After:
appendSequencedEvent(STATE_DIR, {
  ts: coerceTs(ev.ts),
  ...ev,
  ...
});
```

**Site C** — in the `else` branch (no run context):

```js
// Before:
appendSequencedEvent(STATE_DIR, {
  ts: ev.ts ?? new Date().toISOString(),
  ...ev,
  ...
});

// After:
appendSequencedEvent(STATE_DIR, {
  ts: coerceTs(ev.ts),
  ...ev,
  ...
});
```

### Step 3 — Add tests

**File:** `e2e/orchestrationLifecycle.e2e.test.mjs`

```js
it('writes a valid timestamp when agent emits literal <ISO8601> placeholder', async () => {
  const send = vi.fn().mockResolvedValue(
    '[ORC_EVENT] {"event":"run_started","run_id":"run-placeholder","agent_id":"worker-a","ts":"<ISO8601>"}'
  );
  // ... set up agent + claim + dispatch stub ...
  // After tick(), read events.jsonl and assert:
  const events = readEvents(join(dir, 'events.jsonl'));
  const runStarted = events.find((e) => e.event === 'run_started' && e.run_id === 'run-placeholder');
  expect(runStarted).toBeDefined();
  expect(Number.isFinite(new Date(runStarted.ts).getTime())).toBe(true);
  expect(runStarted.ts).not.toBe('<ISO8601>');
});

it('preserves a valid agent-provided timestamp unchanged', async () => {
  const agentTs = '2026-01-15T12:00:00.000Z';
  const send = vi.fn().mockResolvedValue(
    `[ORC_EVENT] {"event":"heartbeat","run_id":"run-hb","agent_id":"worker-a","ts":"${agentTs}"}`
  );
  // ...
  const events = readEvents(join(dir, 'events.jsonl'));
  const hb = events.find((e) => e.event === 'heartbeat' && e.run_id === 'run-hb');
  expect(hb?.ts).toBe(agentTs);
});
```

---

## Acceptance criteria

- [ ] `coordinator.mjs` contains a `coerceTs(ts)` helper function
- [ ] All three `appendSequencedEvent` calls in `recordAdapterResponseEvents` use `coerceTs(ev.ts)` for the `ts` field
- [ ] A response containing `"ts":"<ISO8601>"` results in a valid event being written (no throw, no silent drop)
- [ ] A response containing a valid ISO timestamp preserves that timestamp in the written event
- [ ] `appendEvent` never throws a timestamp-validation error during normal coordinator operation
- [ ] All existing tests pass
- [ ] No changes to `eventLog.mjs`, `ajvFactory.mjs`, `eventValidation.mjs`, or template files

---

## Tests

Add to `e2e/orchestrationLifecycle.e2e.test.mjs`:

```js
it('writes valid timestamp when agent echoes <ISO8601> placeholder', () => { ... });
it('preserves valid agent-provided ISO timestamp', () => { ... });
```

Optionally add a pure unit test for `coerceTs` if it is exported (if kept private, test via
the e2e path above).

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

```bash
# Confirm coerceTs helper is present
grep -n 'coerceTs' coordinator.mjs
# Expected: definition + 3 call-sites

# Confirm no raw ev.ts usage remains
grep -n 'ev\.ts ??' coordinator.mjs
# Expected: no output
```
