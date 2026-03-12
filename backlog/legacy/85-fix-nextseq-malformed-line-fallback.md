# Task 85 — Fix `nextSeq()` Malformed-Line Fallback

Independent. Can run in parallel with Tasks 86–88.

## Scope

**In scope:**
- `lib/eventLog.mjs` — fix `nextSeq()` to scan backwards past malformed lines
- `lib/eventLog.test.mjs` — add regression tests for malformed last line

**Out of scope:**
- `appendEvent`, `appendSequencedEvent`, `readEvents` — no changes
- Any schema, state file, or CLI changes

---

## Context

`nextSeq()` returns the next monotonic sequence number to use when appending an event.
It reads only the last line of `events.jsonl` (O(1)) to avoid parsing the full file.

**The bug (lines 107–113):** if the last line is malformed (truncated write, partial
`atomicWriteJson` failure, disk corruption), `JSON.parse` throws and `nextSeq` returns `1`.
The next appended event then gets `seq: 1`, colliding with the first event in the log.
This corrupts the monotonic ordering guarantee that coordinators and tools depend on.

```js
// current — BUG
try {
  const last = JSON.parse(lastLine);
  return typeof last.seq === 'number' ? last.seq + 1 : 1;
} catch {
  return 1;  // ← collision: duplicate seq values; event ordering broken
}
```

**Affected files:**
- `lib/eventLog.mjs` — `nextSeq()` function, lines 98–114
- `lib/eventLog.test.mjs` — existing `describe('nextSeq', ...)` block

---

## Goals

1. Must never return a seq value lower than the highest seq already present in the file.
2. Must remain O(1) for the common case (valid last line).
3. Must degrade gracefully on corruption: scan backwards to find the last valid line.
4. Must return `1` only when no line with a valid `seq` number exists in the file.
5. Must not change the function signature or behaviour for valid inputs.

---

## Implementation

### Step 1 — Rewrite `nextSeq()` with backwards scan

**File:** `lib/eventLog.mjs`

Replace lines 98–114 with:

```js
/**
 * Return the next sequence number to use when appending an event.
 * Returns 1 for an empty or missing log.
 * O(1) for valid files: reads only the last line.
 * Degrades to O(n) only when the last line is malformed — scans backwards
 * to find the most recent valid line rather than returning a colliding seq.
 */
export function nextSeq(logPath) {
  if (!existsSync(logPath)) return 1;
  const buf = readFileSync(logPath);
  if (buf.length === 0) return 1;

  // Trim trailing newlines and scan backwards, line by line.
  // Normally exits on the first iteration (O(1)); degrades only on corruption.
  let end = buf.length - 1;
  while (end >= 0 && (buf[end] === 0x0a || buf[end] === 0x0d)) end--;

  while (end >= 0) {
    let start = end;
    while (start > 0 && buf[start - 1] !== 0x0a) start--;
    const line = buf.slice(start, end + 1).toString('utf8').trim();
    if (line) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.seq === 'number') return parsed.seq + 1;
      } catch { /* malformed line — keep scanning */ }
    }
    // Advance end to before this line's leading newline.
    end = start - 2;
    while (end >= 0 && (buf[end] === 0x0a || buf[end] === 0x0d)) end--;
  }

  return 1; // no valid seq found anywhere in the file
}
```

No other changes in this file.

---

### Step 2 — Add regression tests

**File:** `lib/eventLog.test.mjs`

Add inside the existing `describe('nextSeq', ...)` block:

```js
it('returns max(seq)+1 when the last line is malformed JSON', () => {
  // Write two valid events followed by a truncated line.
  writeFileSync(logPath, [
    JSON.stringify({ seq: 1, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'coordinator', agent_id: 'a' }),
    JSON.stringify({ seq: 2, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'coordinator', agent_id: 'a' }),
    '{"seq":3,"ts":"t","event":"heartbeat"', // truncated — malformed
  ].join('\n'));
  expect(nextSeq(logPath)).toBe(3); // scans back to seq:2, returns 3
});

it('returns max(seq)+1 when the last line has no seq field', () => {
  writeFileSync(logPath, [
    JSON.stringify({ seq: 5, ts: 't', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'coordinator', agent_id: 'a' }),
    JSON.stringify({ ts: 't', event: 'note' }), // valid JSON but no seq
  ].join('\n'));
  expect(nextSeq(logPath)).toBe(6); // scans back to seq:5
});

it('returns 1 when every line is malformed', () => {
  writeFileSync(logPath, 'not-json\nalso-not-json\n');
  expect(nextSeq(logPath)).toBe(1);
});
```

---

## Acceptance criteria

- [ ] `nextSeq` with a valid last line returns `lastSeq + 1` (existing behaviour preserved).
- [ ] `nextSeq` with a malformed last line returns `secondLastSeq + 1` (not 1).
- [ ] `nextSeq` when all lines are malformed returns `1`.
- [ ] `nextSeq` on empty file returns `1`.
- [ ] `nextSeq` on missing file returns `1`.
- [ ] All existing `eventLog.test.mjs` tests continue to pass.
- [ ] No changes outside `eventLog.mjs` and `eventLog.test.mjs`.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs lib/eventLog.test.mjs
```

---

## Verification

```bash
cd orchestrator && npm test
```

---

## Risk / Rollback

**Risk:** Backwards scan reads more of the file on corruption (bounded by corruption length,
not total file size). No stateful side effects — pure function fix.

**Rollback:** Revert `eventLog.mjs`. Re-run tests to confirm regression is restored.
