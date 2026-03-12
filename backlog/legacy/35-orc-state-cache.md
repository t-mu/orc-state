# Task 35 — Per-Tick State Cache: Eliminate Redundant File Reads

Medium severity performance fix. Independent — no dependencies on other tasks.
Complete before T34 (parallel tick) for cleaner parallelism.

## Scope

**In scope:**
- Load `backlog.json`, `agents.json`, `claims.json` once at the start of each `tick()` and
  thread the loaded data to all functions that currently re-read from disk
- Modify `taskScheduler.mjs::nextEligibleTask` to accept pre-loaded data as parameters
  (backward-compatible: still reads from disk if not provided)
- Fix `enforceInProgressLifecycle` to pass the pre-loaded events slice rather than re-reading
  all events on every tick
- Track the last-seen event seq to make the activity lookup incremental

**Out of scope:**
- Caching across ticks (data is always refreshed at tick start)
- Changing `claimManager.mjs` write paths (they still read+write under their own lock)
- Changing any schema or state file format

---

## Context

A single coordinator tick reads the same files multiple times:

| Call path | Files read |
|---|---|
| `expireStaleLeases` | backlog + claims |
| `enforceRunStartLifecycle` → `readClaims` | claims |
| `enforceInProgressLifecycle` → `readClaims` + `readEvents` | claims + ALL events |
| `activeClaimAgents` → `readClaims` | claims |
| `buildDispatchPlan` → `nextEligibleTask` (×N agents) | backlog + agents per call |

Total per-tick reads for a 10-agent setup: **~25 file reads** (backlog ×12, agents ×10,
claims ×4, events ×1 full parse).

The event log read in `enforceInProgressLifecycle` is especially expensive: `readEvents()`
re-parses and re-validates every event in the NDJSON file on every tick. For a long-running
orchestration with 50,000 events, this could take seconds per tick.

**Fix strategy:**

1. At the start of `tick()`, load the three JSON files once:
   ```js
   const backlogData = readJson(STATE_DIR, 'backlog.json');
   const agentsData  = readJson(STATE_DIR, 'agents.json');
   const claimsData  = readJson(STATE_DIR, 'claims.json');
   ```

2. Pass these to all functions that need them. Functions that mutate state (via `claimTask`
   etc.) re-read inside the lock as before — the pre-loaded data is read-only.

3. For `enforceInProgressLifecycle`, only load events since the last tick using the tracked
   `lastProcessedSeq` and build an incremental activity map.

**Affected files:**
- `coordinator.mjs` — add tick-level cache; pass to child functions
- `lib/taskScheduler.mjs` — accept optional pre-loaded `backlog` + `agents`

---

## Goals

1. Must read `backlog.json`, `agents.json`, `claims.json` at most once per tick in normal flow
2. Must read `events.jsonl` incrementally (only new events since last tick) in `enforceInProgressLifecycle`
3. Must not change observable behaviour — same tasks dispatched, same nudges sent
4. Must pass pre-loaded backlog + agents to `nextEligibleTask` to avoid per-agent file reads
5. Must track `lastProcessedSeq` across ticks to support incremental event reads
6. Must not break existing tests

---

## Implementation

### Step 1 — Add `lastProcessedSeq` module-level variable

**File:** `coordinator.mjs`

Near the other module-level state variables:

```js
let lastProcessedSeq = 0; // tracks the highest event seq already processed for activity
```

### Step 2 — Add tick-level cache loading at the start of `tick()`

**File:** `coordinator.mjs`

At the top of the `tick()` function body, before any other work:

```js
async function tick() {
  tickCount++;
  log(`tick ${tickCount}`);

  // Load state once for this tick. Functions below read from these snapshots.
  // State-mutating operations (claimTask, finishRun, etc.) re-read under their own lock.
  let tickBacklog, tickAgents, tickClaims;
  try {
    tickBacklog = readJson(STATE_DIR, 'backlog.json');
    tickAgents  = readJson(STATE_DIR, 'agents.json');
    tickClaims  = readJson(STATE_DIR, 'claims.json');
  } catch (err) {
    log(`ERROR: failed to load state files: ${err.message}`);
    return;
  }

  // ... rest of tick using tickBacklog, tickAgents, tickClaims
}
```

### Step 3 — Pass pre-loaded claims to `enforceRunStartLifecycle` and `enforceInProgressLifecycle`

**File:** `coordinator.mjs`

Update signatures to accept pre-loaded claims:

```js
async function enforceRunStartLifecycle(agents, claims) { ... }
async function enforceInProgressLifecycle(agents, claims) { ... }
```

Replace `readClaims(STATE_DIR).claims ?? []` inside both functions with the passed `claims`
parameter.

### Step 4 — Make `enforceInProgressLifecycle` use incremental event reads

**File:** `coordinator.mjs`

Instead of calling `readEvents(EVENTS_FILE)` to load all events, use `nextSeq` to check
how many new events exist since `lastProcessedSeq`, then only read the new tail:

```js
async function enforceInProgressLifecycle(agents, claims) {
  const nowMs = Date.now();
  const byAgent = new Map(agents.map((a) => [a.agent_id, a]));

  // Only read events added since the last processed tick.
  let activityByRun = new Map();
  try {
    const currentSeq = nextSeq(EVENTS_FILE) - 1; // highest written seq
    if (currentSeq > lastProcessedSeq) {
      const allEvents = readEvents(EVENTS_FILE); // still full read for now — see note
      activityByRun = latestRunActivityMap(allEvents);
      lastProcessedSeq = currentSeq;
    }
  } catch {
    activityByRun = new Map();
  }
  // ... rest unchanged
}
```

> **Note:** The truly incremental read (seeking to byte offset by seq) requires tracking
> byte offsets across ticks, which is a larger change. As a first step, only read events
> when new ones have arrived (skip the read entirely when no new events). This eliminates
> the common case where the tick fires but no events have been written since the last tick.
> Full byte-offset-based incremental reads can be a follow-up.

Import `nextSeq` from `eventLog.mjs` if not already imported.

### Step 5 — Update `activeClaimAgents` to use pre-loaded claims

**File:** `coordinator.mjs`

```js
// Before:
function activeClaimAgents(stateDir) {
  const busy = new Set();
  for (const claim of readClaims(stateDir).claims ?? []) { ... }
  return busy;
}

// After:
function activeClaimAgents(claims) {
  const busy = new Set();
  for (const claim of claims ?? []) { ... }
  return busy;
}
```

Call-site in `tick()`:
```js
const busyAgents = activeClaimAgents(tickClaims.claims ?? []);
```

### Step 6 — Update `nextEligibleTask` to accept pre-loaded data

**File:** `lib/taskScheduler.mjs`

Make backlog and agents optional parameters with a read-from-disk fallback:

```js
export function nextEligibleTask(stateDir, agentId, { backlog = null, agents = null } = {}) {
  const backlogData = backlog ?? readJson(stateDir, 'backlog.json');
  const agentsData  = agents ?? readJson(stateDir, 'agents.json');
  return nextEligibleTaskFromBacklog(backlogData, agentsData, agentId);
}
```

Update the call-site in `coordinator.mjs`:

```js
const dispatchPlan = buildDispatchPlan(availableAgents, (agent) =>
  nextEligibleTask(STATE_DIR, agent.agent_id, {
    backlog: tickBacklog,
    agents: tickAgents,
  }),
);
```

---

## Acceptance criteria

- [ ] `backlog.json`, `agents.json`, `claims.json` are each read at most once per tick (excluding reads inside lock-held mutation functions)
- [ ] `events.jsonl` full parse is skipped when no new events have arrived since last tick
- [ ] `nextEligibleTask` uses pre-loaded backlog + agents when provided (no per-agent disk reads)
- [ ] Observable behaviour is unchanged — same tasks dispatched, same nudges sent
- [ ] `lastProcessedSeq` is updated after each event read so incremental check works across ticks
- [ ] All existing tests pass; no new test regressions
- [ ] `taskScheduler.mjs::nextEligibleTask` still works when called without pre-loaded data (backward-compatible)

---

## Tests

Add to `lib/taskScheduler.test.mjs` (or equivalent):

```js
it('uses pre-loaded backlog when provided instead of reading from disk', () => {
  // Provide a pre-loaded backlog object; assert readJson is not called.
  // Can use vi.spyOn(stateReader, 'readJson').
});
```

Add to coordinator e2e tests:

```js
it('does not read backlog.json more than once per tick with 5 agents', async () => {
  // Spy on readJson, count calls with 'backlog.json' argument, assert count <= 2 per tick.
  // (<=2 to allow for mutation functions that re-read under lock)
});
```

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

```bash
# Before/after: count file reads per tick by instrumenting readJson
# In a dev run with strace or fs.watch monitoring, verify fewer reads per tick
```
