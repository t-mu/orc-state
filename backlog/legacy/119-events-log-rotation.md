---
ref: orch/task-119-events-log-rotation
epic: orch
status: done
---

# Task 119 — Add events.jsonl Rotation and Compaction

Independent.

## Scope

**In scope:**
- `lib/eventLog.mjs` — add `rotateEventsLogIfNeeded(stateDir, opts)` and update `getRecentEvents` to read across archive files
- `coordinator.mjs` — call rotation check once per tick (after processing events)
- `mcp/handlers.mjs` — `handleGetRecentEvents`: update to read from current + archives
- `lib/eventLog.test.mjs` — unit tests for rotation and cross-file reads

**Out of scope:**
- Compressing archive files (gzip, etc.)
- Remote log shipping
- Changing the seq number generation logic or event schema
- Changes to `masterNotifyQueue.mjs` or `claims.json`

---

## Context

`events.jsonl` grows without bound. At seq 13,064 after normal usage, the file already contains thousands of lines. Every coordinator tick and every `get_recent_events` call reads the tail of this file; at high throughput (many tasks per day) the file size will degrade performance and inflate memory usage in the Node.js process.

The coordinator already tracks the last-processed event seq (`lastProcessedSeq`) to avoid reprocessing. Rotation is safe as long as seq numbers remain monotonic across file boundaries and the incremental read path handles the boundary correctly.

Rotation strategy:
- When `events.jsonl` exceeds a threshold (default: 10,000 lines or 5 MB, whichever comes first), rename it to `events.jsonl.1`, rename any existing `.1` to `.2`, drop `.2` if it existed (keep at most 2 archives).
- Start a fresh `events.jsonl`.
- `getRecentEvents(limit)` reads backwards from `events.jsonl`, then `.1`, then `.2` until `limit` is satisfied.
- `lastProcessedSeq` tracking by the coordinator is unaffected because it tracks by seq number, not file position.

**Affected files:**
- `lib/eventLog.mjs` — rotation and cross-file read
- `coordinator.mjs` — rotation trigger per tick
- `mcp/handlers.mjs` — `handleGetRecentEvents` (delegates to updated `getRecentEvents`)
- `lib/eventLog.test.mjs` — new tests

---

## Goals

1. Must rotate `events.jsonl` to `.1` (shifting `.1` → `.2`, dropping old `.2`) when threshold is exceeded.
2. Must start a fresh `events.jsonl` after rotation with no loss of events.
3. Must preserve monotonic seq numbers across rotation (no reset).
4. Must allow `getRecentEvents(limit)` to satisfy requests spanning the rotation boundary by reading archives.
5. Must trigger rotation check at most once per coordinator tick (not per event write).
6. Must not rotate if threshold is not exceeded (no spurious rotations).

---

## Implementation

### Step 1 — Add rotation utility

**File:** `lib/eventLog.mjs`

```js
const DEFAULT_ROTATE_OPTS = { maxLines: 10_000, maxBytes: 5 * 1024 * 1024 };

export function rotateEventsLogIfNeeded(stateDir, opts = {}) {
  const { maxLines, maxBytes } = { ...DEFAULT_ROTATE_OPTS, ...opts };
  const current = join(stateDir, 'events.jsonl');

  let stat;
  try { stat = statSync(current); } catch { return; } // file doesn't exist yet

  const overBytes = stat.size >= maxBytes;
  const overLines = overBytes ? true : (() => {
    const content = readFileSync(current, 'utf8');
    return content.split('\n').filter(Boolean).length >= maxLines;
  })();

  if (!overBytes && !overLines) return;

  // Shift archives: .2 dropped, .1 → .2, current → .1
  const arc1 = current + '.1';
  const arc2 = current + '.2';
  try { renameSync(arc1, arc2); } catch { /* .1 may not exist */ }
  renameSync(current, arc1);
  // Fresh file will be created naturally on next appendSequencedEvent call.
}
```

### Step 2 — Update getRecentEvents to read archives

**File:** `lib/eventLog.mjs`

```js
export function getRecentEvents(stateDir, limit = 50) {
  const candidates = ['events.jsonl', 'events.jsonl.1', 'events.jsonl.2']
    .map((f) => join(stateDir, f));

  const allLines = [];
  for (const filePath of candidates) {
    try {
      const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      allLines.unshift(...lines); // prepend older file contents
    } catch { /* file absent — skip */ }
    if (allLines.length >= limit * 2) break; // read enough, stop early
  }

  return allLines
    .slice(-limit)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}
```

### Step 3 — Trigger rotation in coordinator tick

**File:** `coordinator.mjs`

At the end of the tick (after `processTerminalRunEvents`), add:

```js
import { rotateEventsLogIfNeeded } from './lib/eventLog.mjs';

// In tick():
rotateEventsLogIfNeeded(stateDir);
```

### Step 4 — handleGetRecentEvents delegates to updated utility

**File:** `mcp/handlers.mjs`

Replace the inline `readEventsLines` + split logic with a call to `getRecentEvents(stateDir, cap)` from `eventLog.mjs`. Remove the now-unused `readEventsLines` private function.

---

## Acceptance criteria

- [ ] `rotateEventsLogIfNeeded` renames `events.jsonl` to `events.jsonl.1` when line count ≥ 10,000.
- [ ] A second rotation drops `events.jsonl.2` and shifts `.1` → `.2`, current → `.1`.
- [ ] After rotation, a fresh `events.jsonl` is created by the next event append and seq numbers continue from where they left off.
- [ ] `getRecentEvents(50)` returns events spanning the rotation boundary (reading from current + `.1`).
- [ ] `handleGetRecentEvents` returns correct events after rotation.
- [ ] Rotation is skipped when file is below both thresholds.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `lib/eventLog.test.mjs`:

```js
it('rotateEventsLogIfNeeded does nothing when file is below threshold');
it('rotateEventsLogIfNeeded rotates current to .1 when over line threshold');
it('rotateEventsLogIfNeeded shifts .1 to .2 and drops old .2 on second rotation');
it('getRecentEvents reads across current and .1 archive to satisfy limit');
it('seq numbers remain monotonic after rotation');
```

---

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

## Risk / Rollback

**Risk:** A crash between `renameSync(current, arc1)` and the first new append leaves `events.jsonl` absent. The coordinator handles a missing events file gracefully (returns empty on read). No events are lost — they are in `.1`.

**Rollback:** `git restore lib/eventLog.mjs coordinator.mjs mcp/handlers.mjs && npm test`. Archive files are safe to rename back manually if needed.
