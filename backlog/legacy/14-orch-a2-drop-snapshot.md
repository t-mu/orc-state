# Task 14 — Orchestrator A2: Remove Snapshot, Projection, and Seq Cursor

> **Track A — Step 2 of 3.** Requires Task 13 (A1) to be complete first.

## Context

The system maintains `orchestrator/state/snapshot.json` — a materialised projection of the three base files (`backlog.json`, `agents.json`, `claims.json`) plus the event log. It is rebuilt by `lib/recover.mjs` (107 lines) using `lib/projection.mjs` (240 lines). The coordinator calls `repairOnStartup()` on every tick to ensure the snapshot is current.

The coordinator itself **never reads the snapshot at runtime** — it reads base files directly via `withLock`. The snapshot only serves `lib/statusView.mjs` (the `orc:status` command). In `statusView.mjs` (lines 10–18):

```js
const snapshotPath = join(stateDir, 'snapshot.json');
const snapshot = existsSync(snapshotPath)
  ? JSON.parse(readFileSync(snapshotPath, 'utf8'))
  : null;

const agents      = Object.values(snapshot?.agents ?? {});
const claims      = Object.values(snapshot?.claims ?? {});
const taskStatuses = snapshot?.task_statuses ?? {};
```

A separate cursor file `events.seq` is used in `lib/eventLog.mjs` (lines 40–80) to avoid scanning the full event log on every append. In practice `nextSeq()` already scans the log anyway (it is the fallback), so the cursor trades complexity for marginal performance:

```js
function readSeqCursor(seqPath) { ... }
function writeSeqCursor(seqPath, seq) { ... }
export function syncEventSeqCursor(stateDir, maxSeq = null) { ... }
```

`appendSequencedEvent` (lines 59–80) reads the cursor, falls back to `nextSeq()` on miss, then writes it back — two extra disk operations per event write.

---

## Goals

1. Delete `lib/projection.mjs` and `lib/recover.mjs`.
2. Remove the seq cursor from `lib/eventLog.mjs` — always derive seq from the log.
3. Remove `syncEventSeqCursor` export (its only consumer is `recover.mjs`).
4. Rewrite `lib/statusView.mjs` to read directly from `backlog.json`, `agents.json`, `claims.json`.
5. Remove `repairOnStartup` from `coordinator.mjs`; replace with a startup existence guard.
6. Remove `snapshot.json` and `events.seq` from `orchestrator/state/`.

---

## Step-by-Step Instructions

### Step 1 — Delete `lib/projection.mjs` and `lib/recover.mjs`

Delete both files entirely. No other file imports from them after this task (verify with a grep before deleting).

### Step 2 — Simplify `lib/eventLog.mjs`

Delete the three seq cursor functions:
- `readSeqCursor()` (lines 40–47)
- `writeSeqCursor()` (lines 49–51)
- `syncEventSeqCursor()` export (lines 86–91)

Simplify `appendSequencedEvent` to always call `nextSeq()`:

```js
// BEFORE:
const append = () => {
  const cursor = readSeqCursor(seqPath);
  const seq = cursor == null ? nextSeq(logPath) : cursor + 1;
  appendEvent(logPath, { ...event, seq }, { fsyncPolicy });
  writeSeqCursor(seqPath, seq);
  return seq;
};

// AFTER:
const append = () => {
  const seq = nextSeq(logPath);
  appendEvent(logPath, { ...event, seq }, { fsyncPolicy });
  return seq;
};
```

Remove the `seqPath` variable declaration since it is no longer needed. Remove `writeFileSync` from the `node:fs` import at the top of the file if it is no longer used elsewhere in the file.

### Step 3 — Update `lib/stateValidation.mjs`

Open `lib/stateValidation.mjs`. Find the snapshot validator setup and remove it:
- Remove the `loadSchema('snapshot.schema.json')` + `ajv.compile(...)` call for snapshot.
- Remove `validateSnapshot` from the exports.
- Remove `'snapshot.json'` from the `validators` array inside `validateStateDir()`.

The file still validates `backlog.json`, `agents.json`, `claims.json`, and events.

### Step 4 — Update `coordinator.mjs`

Remove the import of `repairOnStartup`:

```js
// DELETE:
import { repairOnStartup } from './lib/recover.mjs';
```

In `tick()`, remove the `repairOnStartup(STATE_DIR)` call (it is the first line of the tick body).

In `main()`, before the first `await tick()`, add a startup guard:

```js
import { existsSync } from 'node:fs';
// ...
for (const file of ['backlog.json', 'agents.json', 'claims.json', 'events.jsonl']) {
  if (!existsSync(join(STATE_DIR, file))) {
    console.error(`[coordinator] ERROR: required state file missing: ${file}`);
    process.exit(1);
  }
}
```

> **Verify:** `existsSync` and `join` may already be imported from `node:fs` and `node:path`. Do not add duplicate imports.

### Step 5 — Rewrite `lib/statusView.mjs`

Replace the snapshot read block (lines 10–18) with direct reads from base files:

```js
// BEFORE:
const snapshotPath = join(stateDir, 'snapshot.json');
const snapshot = existsSync(snapshotPath)
  ? JSON.parse(readFileSync(snapshotPath, 'utf8'))
  : null;
const agents      = Object.values(snapshot?.agents ?? {});
const claims      = Object.values(snapshot?.claims ?? {});
const taskStatuses = snapshot?.task_statuses ?? {};

// AFTER:
import { readJson } from './stateReader.mjs';
// ...
const agentsFile  = readJson(stateDir, 'agents.json');
const claimsFile  = readJson(stateDir, 'claims.json');
const backlogFile = readJson(stateDir, 'backlog.json');

const agents = agentsFile.agents ?? [];
const claims = claimsFile.claims ?? [];

// Build taskStatuses from backlog:
const taskStatuses = {};
for (const epic of (backlogFile.epics ?? [])) {
  for (const task of (epic.tasks ?? [])) {
    taskStatuses[task.ref] = task.status;
  }
}
```

Remove the `existsSync` import from `node:fs` if it is no longer needed elsewhere in the file.

Also remove the `communications` tracking block (lines 42–66) — `communicationTypes`, `communicationCounts`, `pendingReviewTaskRefs` — since those event types are deleted by B1. Remove the corresponding `communications` key from the returned object (lines 109–113) and remove the formatting lines in `formatStatus` that print communication counts (lines 175–183).

Update the returned object to remove `snapshot_rebuilt_at` and `last_event_seq` since snapshot no longer exists:

```js
// BEFORE:
return {
  snapshot_rebuilt_at: snapshot?.rebuilt_at ?? null,
  last_event_seq:      snapshot?.last_event_seq ?? 0,
  ...
};

// AFTER:
return {
  // snapshot fields removed
  ...
};
```

Update `formatStatus` to remove the `Snapshot:` line (lines 128–132).

### Step 6 — Delete state files

Delete `orchestrator/state/snapshot.json` if it exists.
Delete `orchestrator/state/events.seq` if it exists.

### Step 7 — Run tests

```
nvm use 22 && npm test
```

Confirm `npm run orc:status` still prints an agent/task/claims table (it now reads from base files). Confirm `npm run orc:doctor` reports no errors.

---

## Acceptance Criteria

- [ ] `lib/projection.mjs` is deleted.
- [ ] `lib/recover.mjs` is deleted.
- [ ] `state/snapshot.json` does not exist (deleted and not recreated).
- [ ] `state/events.seq` does not exist (deleted and not recreated).
- [ ] `lib/eventLog.mjs` has no `readSeqCursor`, `writeSeqCursor`, or `syncEventSeqCursor` functions.
- [ ] `appendSequencedEvent` always calls `nextSeq()` directly — no cursor file read/write.
- [ ] `lib/stateValidation.mjs` does not reference `snapshot.json` or `validateSnapshot`.
- [ ] `coordinator.mjs` does not import or call `repairOnStartup`; `main()` has a base-file existence guard.
- [ ] `lib/statusView.mjs` reads from `backlog.json`, `agents.json`, `claims.json` directly — no `snapshot.json` reference.
- [ ] All existing orchestrator tests pass.
