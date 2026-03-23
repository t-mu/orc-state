---
ref: general/24-events-sqlite-migration
feature: general
priority: normal
status: todo
---

# Task 24 — Migrate events.jsonl to SQLite with FTS5

Independent.

## Scope

**In scope:**
- Replace the NDJSON file implementation in `lib/eventLog.ts` with SQLite (WAL mode + FTS5 virtual table) while keeping the public API identical
- One-time migration: import existing `events.jsonl` into `events.db` on first startup if the file exists
- Update `mcp/tools/query-events.ts` (or equivalent) to use SQL filtering instead of linear scan
- Add `better-sqlite3` as a pinned exact-version dependency in `package.json`
- Update all tests in `lib/eventLog.test.ts` to pass against the new implementation

**Out of scope:**
- Changing the public API of `lib/eventLog.ts` — all existing callers remain unmodified
- Migrating `backlog.json`, `agents.json`, or `claims.json` to SQLite
- Exposing raw SQL to callers — all DB access stays inside `lib/eventLog.ts`
- Distributing or archiving the `.db` file — treat it as a local runtime artifact like `events.jsonl`
- Changing the event schema or adding new event types

---

## Context

`lib/eventLog.ts` stores events as NDJSON lines in `.orc-state/events.jsonl`, with a two-file rotation scheme (`.jsonl.1`, `.jsonl.2`). Every read operation requires loading and parsing entire files in memory. The `query_events` MCP tool does a linear scan with in-memory filter on the full event set on each call. Seq allocation requires acquiring the state lock (`withLock`).

At current scale this is fine, but as the event log grows (long-running orchestrator sessions, many workers) the linear-scan cost compounds. SQLite WAL mode provides concurrent readers, atomic writes without a file lock, and FTS5 enables sub-millisecond full-text search across `event`, `agent_id`, `run_id`, `task_ref`, and the full payload.

The migration is low risk because the public API is narrow and fully covered by the existing test suite. The `better-sqlite3` driver is synchronous, so no async model change is required.

### Current state

- Events stored in `.orc-state/events.jsonl` (NDJSON, append-only)
- Rotation: when file exceeds 10,000 lines or 5 MB, rotate to `.jsonl.1` / `.jsonl.2`
- Seq allocated under `withLock` by reading last line of the file
- `readRecentEvents` loads all three archive files, concatenates, and slices
- `query_events` MCP tool: loads all events, filters in memory by `run_id`, `agent_id`, `event_type`, `after_seq`

### Desired state

- Events stored in `.orc-state/events.db` (SQLite, WAL journal mode)
- Schema:
  ```sql
  CREATE TABLE events (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id  TEXT    NOT NULL UNIQUE,
    ts        TEXT    NOT NULL,
    event     TEXT    NOT NULL,
    agent_id  TEXT,
    run_id    TEXT,
    task_ref  TEXT,
    payload   TEXT    NOT NULL   -- full JSON of the event object
  );
  CREATE VIRTUAL TABLE events_fts USING fts5(
    event, agent_id, run_id, task_ref, payload,
    content='events', content_rowid='seq'
  );
  ```
- `appendEvent`: `INSERT INTO events ... RETURNING seq` inside a transaction; seq from AUTOINCREMENT
- `readEvents`: `SELECT payload FROM events ORDER BY seq`
- `readEventsSince(afterSeq)`: `SELECT payload FROM events WHERE seq > ? ORDER BY seq`
- `readRecentEvents(limit)`: `SELECT payload FROM events ORDER BY seq DESC LIMIT ?` reversed
- `query_events` MCP tool: SQL `WHERE` clause for structured filters + FTS5 `MATCH` for text search
- On first start: if `events.jsonl` exists and `events.db` does not, import all events and rename `events.jsonl` → `events.jsonl.migrated`
- Rotation logic and `.jsonl.1` / `.jsonl.2` archive files removed

### Start here

- `lib/eventLog.ts` — the file to rewrite; read its full public API surface first
- `lib/eventLog.test.ts` — the test suite that defines the contract; all tests must pass
- `package.json` — to add `better-sqlite3` pinned version

**Affected files:**
- `lib/eventLog.ts` — full rewrite of implementation, public API unchanged
- `lib/eventLog.test.ts` — update mocks/setup for SQLite; add FTS5 and migration tests
- `package.json` — add `better-sqlite3` (exact version, no `^` or `~`)
- `mcp/` — update `query_events` handler to use SQL filters

---

## Goals

1. Must keep the public API of `lib/eventLog.ts` identical: `appendEvent`, `appendSequencedEvent`, `readEvents`, `readEventsSince`, `readRecentEvents`, `nextSeq`, `rotateEventsLogIfNeeded` (may become a no-op), `ensureEventIdentity`, `eventIdentity`.
2. Must store events in `events.db` (SQLite WAL) with the schema above.
3. Must provide an FTS5 virtual table `events_fts` covering `event`, `agent_id`, `run_id`, `task_ref`, and `payload`.
4. Must auto-migrate `events.jsonl` → `events.db` on first open if the JSONL file exists and the DB does not.
5. Must update `query_events` MCP tool to use SQL `WHERE` + FTS5 `MATCH` instead of linear scan.
6. Must add `better-sqlite3` as an exact-pinned version dependency (no range specifiers).
7. Must pass all existing `lib/eventLog.test.ts` tests and add tests for FTS5 search and migration.
8. Must pass `orc doctor` (exits 0) after the change.

---

## Implementation

### Step 1 — Pin better-sqlite3 dependency

**File:** `package.json`

Find the current version of `better-sqlite3` available via npm and add it as an exact pin:
```json
"better-sqlite3": "<exact version>"
```
Also add `@types/better-sqlite3` to `devDependencies` at the exact matching version.

Run `npm install` to lock it.

### Step 2 — Rewrite lib/eventLog.ts

**File:** `lib/eventLog.ts`

Replace the NDJSON implementation with SQLite. Key points:

- Open/create the DB lazily on first call via a module-level singleton: `let _db: Database | null = null; function getDb(stateDir: string): Database { ... }`
- `getDb()` runs `PRAGMA journal_mode=WAL`, creates the `events` table and `events_fts` virtual table if they don't exist, and runs the one-time migration if needed.
- `appendSequencedEvent`: use `INSERT INTO events (event_id, ts, event, agent_id, run_id, task_ref, payload) VALUES (...)` — seq is AUTOINCREMENT; read back the `lastInsertRowid`.
- `nextSeq()`: `SELECT MAX(seq) FROM events` + 1, or 1 if empty. (Kept for API compat but seq is now DB-assigned.)
- `rotateEventsLogIfNeeded()`: becomes a no-op returning `false` (DB handles retention implicitly).
- Preserve `ensureEventIdentity` and `eventIdentity` as-is (pure functions, no I/O).

### Step 3 — One-time migration

**File:** `lib/eventLog.ts` (inside `getDb()`)

```ts
function migrateJsonlIfNeeded(db: Database, stateDir: string): void {
  const jsonlPath = join(stateDir, 'events.jsonl');
  const migratedPath = join(stateDir, 'events.jsonl.migrated');
  if (!existsSync(jsonlPath) || existsSync(migratedPath)) return;

  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  const insert = db.prepare(`INSERT OR IGNORE INTO events (...) VALUES (...)`);
  const migrate = db.transaction(() => { for (const line of lines) { ... insert.run(...); } });
  migrate();
  renameSync(jsonlPath, migratedPath);
}
```

### Step 4 — Update query_events MCP tool

**File:** Inspect `mcp/` directory for the `query_events` handler.

Replace the in-memory filter loop with a SQL query builder:
- `run_id`, `agent_id`, `event_type` filters → `WHERE run_id = ?`, `WHERE agent_id = ?`, `WHERE event = ?`
- `after_seq` → `WHERE seq > ?`
- Full-text search (if applicable) → `JOIN events_fts ON events_fts.rowid = events.seq WHERE events_fts MATCH ?`
- `limit` → `LIMIT ?`

### Step 5 — Update tests

**File:** `lib/eventLog.test.ts`

- Replace any file-path-based setup with a temp directory (already done via `ORCH_STATE_DIR`); SQLite DB will land in the same temp dir
- Remove tests specific to the rotation/archive scheme that no longer applies
- Add: FTS5 search test, migration import test, WAL concurrent-read test

---

## Acceptance criteria

- [ ] All pre-existing `lib/eventLog.test.ts` tests pass against the new SQLite implementation.
- [ ] Events are written to `.orc-state/events.db` (SQLite WAL); `events.jsonl` is no longer written on a fresh installation.
- [ ] `appendSequencedEvent` writes atomically without requiring `withLock` for seq allocation.
- [ ] `readRecentEvents(limit)` returns the correct tail of events from the DB.
- [ ] FTS5 search: `query_events` with a text filter uses `MATCH` and returns correct results.
- [ ] On first startup with an existing `events.jsonl`, all events are imported and `events.jsonl` is renamed to `events.jsonl.migrated`.
- [ ] `rotateEventsLogIfNeeded()` returns `false` without error (no-op).
- [ ] `better-sqlite3` is added to `package.json` with an exact pinned version (no `^` or `~`).
- [ ] `npm test` passes.
- [ ] `orc doctor` exits 0.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/eventLog.test.ts`:

```ts
it('stores events in events.db and not events.jsonl on a fresh state dir', () => { ... });
it('FTS5 search: readRecentEvents after appending returns events matching event type', () => { ... });
it('migrates existing events.jsonl into events.db on first open', () => {
  // Write a small events.jsonl fixture to the temp dir
  // Call appendSequencedEvent (triggers getDb → migration)
  // Assert all fixture events present in DB
  // Assert events.jsonl.migrated exists, events.jsonl does not
});
it('concurrent reads return consistent results (WAL mode)', async () => { ... });
it('rotateEventsLogIfNeeded is a no-op returning false', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/eventLog.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
orc status
# Expected: exits 0, no validation errors
```

```bash
# Manual smoke check
# Start the coordinator, emit a few events, then:
sqlite3 .orc-state/events.db "SELECT seq, event, agent_id FROM events ORDER BY seq DESC LIMIT 5;"
sqlite3 .orc-state/events.db "SELECT snippet(events_fts, 0, '>', '<', '...', 10) FROM events_fts WHERE events_fts MATCH 'run_start';"
```

## Risk / Rollback

**Risk:** `better-sqlite3` requires a native addon compiled for the running Node version. If the build environment lacks `python` / `node-gyp` prerequisites, `npm install` will fail. The synchronous DB singleton also means a crash inside `getDb()` on first call could take down the coordinator process rather than degrading gracefully.

**Rollback:** Remove `better-sqlite3` from `package.json`, restore `lib/eventLog.ts` from git, run `npm install && npm test`. The `events.jsonl.migrated` file can be renamed back to `events.jsonl` to restore the prior event history.
