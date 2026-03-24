---
ref: general/37-fix-stale-events-jsonl-references
feature: general
priority: normal
status: todo
---

# Task 37 — Fix Stale `events.jsonl` References After SQLite Migration

Independent.

## Scope

**In scope:**
- Update the two stale error message strings in `readEvents()` (`lib/eventLog.ts`) from `"events.jsonl schema error"` / `"events.jsonl parse error"` to `"events.db schema error"` / `"events.db parse error"`, including the re-throw guard string
- Update three test assertions that hard-code the old error strings (`lib/eventLog.test.ts`, `cli/runs-active.test.ts`, `cli/status.test.ts`)
- Fix the path argument in `stateValidation.ts` from `eventsJsonlPath` to `eventsDbPath`
- Fix `cli/run-input-respond.ts` to query SQLite instead of `readFileSync` on `events.jsonl`
- Fix `cli/events-filter.ts` and `cli/waiting-input.ts` which both call `readFileSync` directly on `events.jsonl` (real functional bugs, not cosmetic)
- Fix `cli/runs-active.ts` hard-coded `'events.jsonl'` path string
- Fix `lib/lifecycleDiagnostics.ts` stale path and user-facing error message string
- Rename `EVENTS_FILE` export in `lib/paths.ts` from pointing to `events.jsonl` to `events.db`; update `lib/paths.test.ts` to match

**Out of scope:**
- `lib/statusView.ts` — owned by task 34
- `cli/start-session.ts` bootstrap guard (harmless, separate concern)
- e2e test helpers that read `events.jsonl` directly (separate concern)
- Any changes to the SQLite schema, event types, or coordinator logic

---

## Context

Task 24 migrated the event store from `events.jsonl` to SQLite (`events.db`). The migration runs once on first startup: it imports existing `.jsonl` content into SQLite, then renames `events.jsonl` to `events.jsonl.migrated`. After that point, all writes go to SQLite only.

Several callers were not updated. Some are cosmetic (passing `events.jsonl` to functions that only use `dirname()` to derive `stateDir`); others are real functional bugs where code calls `readFileSync` directly on `events.jsonl`, which is absent post-migration.

The `orc doctor` command currently reports a schema error whose message says `"events.jsonl schema error at line 138"` — this is misleading because the file being read is `events.db`, not `events.jsonl`. The error label is a stale string from before the migration.

### Current state

- `readEvents()` reads from SQLite but emits `"events.jsonl schema error at line N"` error messages.
- `cli/events-filter.ts`, `cli/waiting-input.ts`, and `cli/run-input-respond.ts` all call `readFileSync(join(STATE_DIR, 'events.jsonl'), ...)` directly — post-migration these silently return empty or missing data.
- `cli/runs-active.ts` hard-codes the `'events.jsonl'` path string.
- `lib/lifecycleDiagnostics.ts` passes `events.jsonl` to `readEvents()` and emits `"events.jsonl contains duplicate event identity"` in diagnostics.
- `lib/paths.ts` exports `EVENTS_FILE` pointing to `events.jsonl`.

### Desired state

- All error messages and diagnostic strings reference `events.db`.
- No production code calls `readFileSync` on `events.jsonl` directly.
- `EVENTS_FILE` points to `events.db`.
- `orc doctor` reports 0 state errors on a healthy post-migration state directory (once task 31's schema fix also lands).

### Start here

- `lib/eventLog.ts` — `readEvents()` function, lines 251–273, contains the stale error strings
- `cli/run-input-respond.ts` — direct `readFileSync` on `events.jsonl`, the most impactful bug
- `lib/paths.ts` — `EVENTS_FILE` constant

**Affected files:**
- `lib/eventLog.ts` — stale error message strings in `readEvents()`
- `lib/stateValidation.ts` — passes `eventsJsonlPath` to `readEvents()`
- `lib/lifecycleDiagnostics.ts` — stale path + user-facing message string
- `lib/paths.ts` — `EVENTS_FILE` constant value
- `lib/paths.test.ts` — asserts old `EVENTS_FILE` value
- `cli/run-input-respond.ts` — `readFileSync` on `events.jsonl`
- `cli/events-filter.ts` — `readFileSync` on `events.jsonl`
- `cli/waiting-input.ts` — `readFileSync` on `events.jsonl`
- `cli/runs-active.ts` — hard-coded `'events.jsonl'` string
- `lib/eventLog.test.ts` — asserts old error string
- `cli/runs-active.test.ts` — asserts old error string
- `cli/status.test.ts` — asserts old error string

---

## Goals

1. Must: `readEvents()` error messages reference `events.db` and `row N`, not `events.jsonl` and `line N`.
2. Must: `cli/events-filter.ts` and `cli/waiting-input.ts` read from SQLite; they must not call `readFileSync` on `events.jsonl`.
3. Must: `cli/run-input-respond.ts` retrieves the most recent `input_requested` event from SQLite.
4. Must: `EVENTS_FILE` in `lib/paths.ts` resolves to `events.db`.
5. Must: `npm test` passes with zero failures after all changes.
6. Must: `orc doctor` reports 0 lifecycle issues and 0 state errors on a healthy state directory (independent of the `review_submitted` schema issue owned by task 31).
7. Must: No files outside the stated scope are modified.

---

## Implementation

### Step 1 — Update error strings in `readEvents()` (`lib/eventLog.ts`)

**File:** `lib/eventLog.ts`

Change the three string literals atomically (message, guard check, and second error label must all change together or the re-throw logic breaks):

```typescript
// Before
throw new Error(`events.jsonl schema error at line ${i + 1}: ${validationErrors.join('; ')}`);
// ...
if (String((error as Error).message ?? '').startsWith('events.jsonl schema error at line')) {
// ...
throw new Error(`events.jsonl parse error at line ${i + 1}: ${(error as Error).message}`);

// After
throw new Error(`events.db schema error at row ${i + 1}: ${validationErrors.join('; ')}`);
// ...
if (String((error as Error).message ?? '').startsWith('events.db schema error at row')) {
// ...
throw new Error(`events.db parse error at row ${i + 1}: ${(error as Error).message}`);
```

**Invariant:** Change all three strings in one edit — if the guard string is not updated atomically with the throw, the re-throw logic will double-wrap the error.

### Step 2 — Update `lib/paths.ts` `EVENTS_FILE` constant

**File:** `lib/paths.ts`

```typescript
// Before
export const EVENTS_FILE = resolve(STATE_DIR, 'events.jsonl');

// After
export const EVENTS_FILE = resolve(STATE_DIR, 'events.db');
```

### Step 3 — Fix path argument in `stateValidation.ts`

**File:** `lib/stateValidation.ts`

```typescript
// Before
readEvents(eventsJsonlPath);

// After
readEvents(eventsDbPath);
```

### Step 4 — Fix `lib/lifecycleDiagnostics.ts`

**File:** `lib/lifecycleDiagnostics.ts`

Two changes:
1. Line 188: pass `eventsDbPath` (or `join(stateDir, 'events.db')`) to `readEvents()` instead of `events.jsonl`.
2. Line 195: update the user-facing message from `"events.jsonl contains duplicate event identity"` to `"events.db contains duplicate event identity"`.

### Step 5 — Fix `cli/runs-active.ts`

**File:** `cli/runs-active.ts`

```typescript
// Before
readEvents(join(STATE_DIR, 'events.jsonl'))

// After
readEvents(join(STATE_DIR, 'events.db'))
```

### Step 6 — Fix `cli/run-input-respond.ts` (functional bug)

**File:** `cli/run-input-respond.ts`

Replace the `readFileSync` block that reads `events.jsonl` directly. Use `readEventsSince` to query all events from SQLite, then find the most recent `input_requested` event for the given `run_id` and `agent_id`:

```typescript
import { readEventsSince } from '../lib/eventLog.ts';

function readLatestInputRequest(
  currentRunId: string,
  currentAgentId: string,
): Record<string, unknown> | null {
  try {
    const events = readEventsSince(join(STATE_DIR, 'events.db'), 0);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as unknown as Record<string, unknown>;
      if (
        ev.event === 'input_requested' &&
        ev.run_id === currentRunId &&
        ev.agent_id === currentAgentId
      ) {
        return ev;
      }
    }
    return null;
  } catch {
    return null;
  }
}
```

Remove the `readFileSync` import if it is no longer used after this change.

### Step 7 — Fix `cli/events-filter.ts` (functional bug)

**File:** `cli/events-filter.ts`

Replace the direct `existsSync` + `readFileSync` on `events.jsonl` with a call to `readEvents(join(STATE_DIR, 'events.db'))`. Adjust downstream parsing to use the already-parsed `OrcEvent[]` array rather than re-parsing NDJSON lines.

### Step 8 — Fix `cli/waiting-input.ts` (functional bug)

**File:** `cli/waiting-input.ts`

Same pattern as step 7: replace direct `existsSync` + `readFileSync` on `events.jsonl` with a call to `readEvents(join(STATE_DIR, 'events.db'))`.

### Step 9 — Update three test assertions

**Files:** `lib/eventLog.test.ts`, `cli/runs-active.test.ts`, `cli/status.test.ts`

Update each assertion that checks for the old error string prefix:

```typescript
// Before (all three files, slightly varying context)
toThrow('events.jsonl schema error at line 2')
toContain('events.jsonl schema error at line 1')

// After
toThrow('events.db schema error at row 2')
toContain('events.db schema error at row 1')
```

Also update `lib/paths.test.ts` to assert the new `EVENTS_FILE` value:

```typescript
// Before
expect(EVENTS_FILE).toMatch(/events\.jsonl$/)

// After
expect(EVENTS_FILE).toMatch(/events\.db$/)
```

---

## Acceptance criteria

- [ ] `orc doctor` exits with 0 lifecycle issues and 0 state errors on a post-migration state dir (excluding the `review_submitted` schema error owned by task 31).
- [ ] `cli/events-filter.ts` returns correct output when `events.jsonl` is absent and `events.db` is present.
- [ ] `cli/waiting-input.ts` returns correct output when `events.jsonl` is absent and `events.db` is present.
- [ ] `cli/run-input-respond.ts` correctly resolves `task_ref` and `question` from SQLite when `events.jsonl` is absent.
- [ ] `EVENTS_FILE` from `lib/paths.ts` resolves to a path ending in `events.db`.
- [ ] No occurrence of `'events.jsonl schema error'` or `'events.jsonl parse error'` remains in production source files.
- [ ] `npm test` passes with zero failures.
- [ ] No files outside the stated scope are modified.

---

## Tests

Update in `lib/eventLog.test.ts`:
```typescript
// Change assertion to match new error prefix
expect(() => readEvents(logPath)).toThrow('events.db schema error at row 2');
```

Update in `cli/runs-active.test.ts`:
```typescript
expect(json.event_read_error).toContain('events.db schema error at row 1');
```

Update in `cli/status.test.ts`:
```typescript
expect(result.stderr).toContain('events.db schema error at row 1');
```

Update in `lib/paths.test.ts`:
```typescript
expect(EVENTS_FILE).toMatch(/events\.db$/);
```

---

## Verification

```bash
# Targeted: error string and path constant tests
nvm use 24 && npx vitest run lib/eventLog.test.ts lib/paths.test.ts cli/runs-active.test.ts cli/status.test.ts
```

```bash
# Full suite
nvm use 24 && npm test
```

```bash
# Smoke check
orc doctor
# Expected: 0 lifecycle issues, 0 state errors (or only the review_submitted schema error if task 31 is not yet merged)
```
