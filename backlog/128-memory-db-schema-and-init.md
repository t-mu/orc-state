---
ref: memory-foundation/128-memory-db-schema-and-init
feature: memory-foundation
priority: normal
status: done
---

# Task 128 — Create Memory Database Schema and Initialization

Independent.

## Scope

**In scope:**
- New `lib/memoryStore.ts` module with SQLite schema, init, and connection lifecycle
- `registerDb`/`unregisterDb` exports added to `lib/eventLog.ts` for cross-module DB registration
- `stateInit.ts` updated to call `initMemoryDb()` alongside events DB init
- AGENTS.md state files table updated to list `memory.db`

**Out of scope:**
- CRUD operations on drawers (Task 129)
- FTS5 search logic (Task 131)
- MCP tools, CLI commands, or coordinator integration

---

## Context

### Current state

The orchestrator has a single SQLite database (`events.db`) for event storage, managed by
`lib/eventLog.ts` with a module-private `_dbs` Map for connection pooling and WAL mode for
durability. There is no persistent memory system — every worker session starts with zero
knowledge of past sessions.

### Desired state

A new `memory.db` SQLite database exists alongside `events.db` in `.orc-state/`. It stores
"drawers" (memory chunks) with spatial coordinates (wing/hall/room), importance scores,
tags, and source tracking. An FTS5 virtual table enables full-text search. The connection
lifecycle integrates with the existing `closeAllDatabases()` shutdown path.

### Start here

- `lib/eventLog.ts` — reference for singleton DB pattern, WAL mode, FTS5 setup, `closeAllDatabases()`
- `lib/stateInit.ts` — where DB initialization is called during startup
- `AGENTS.md` — state files table to update

**Affected files:**
- `lib/memoryStore.ts` — new file: memory DB schema, init, connection management
- `lib/eventLog.ts` — add `registerDb()`/`unregisterDb()` exports
- `lib/stateInit.ts` — call `initMemoryDb()` at startup
- `AGENTS.md` — document memory.db in state files table

---

## Goals

1. Must create `lib/memoryStore.ts` with `initMemoryDb(stateDir)` that creates the `drawers` table, `drawers_fts` FTS5 virtual table, and auto-insert trigger.
2. Must use WAL mode and `busy_timeout=5000` pragma for concurrent writer safety.
3. Must add `registerDb(key, db)` and `unregisterDb(key)` to `lib/eventLog.ts` so external modules can register DB connections for unified shutdown.
4. Must register the memory DB connection via `registerDb()` so `closeAllDatabases()` covers it.
5. Must update `stateInit.ts` to call `initMemoryDb()`.
6. Must update AGENTS.md state files table to list `memory.db`.

---

## Implementation

### Step 1 — Add registerDb/unregisterDb to eventLog.ts

**File:** `lib/eventLog.ts`

Add two exported functions that allow external modules to register their DB connections
in the existing `_dbs` Map.

Note: the existing `_dbs` Map uses `stateDir` (a path string) as keys for event DBs.
The `registerDb` function uses a caller-chosen key. To stay consistent, memory callers
should use `stateDir + ':memory'` as the key (path-scoped, avoids collision):

```ts
export function registerDb(key: string, db: Database): void {
  _dbs.set(key, db);
}

export function unregisterDb(key: string): void {
  _dbs.delete(key);
}
```

This ensures `closeAllDatabases()` (which iterates `_dbs`) covers all registered databases.

Invariant: do not change the existing `_dbs` visibility or `closeAllDatabases()` logic.

### Step 2 — Create lib/memoryStore.ts

**File:** `lib/memoryStore.ts`

```ts
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { registerDb, unregisterDb } from './eventLog.ts';

const MEMORY_DB_FILE = 'memory.db';
let _memDb: Database | null = null;

export function initMemoryDb(stateDir: string): Database {
  if (_memDb) return _memDb;
  const dbPath = join(stateDir, MEMORY_DB_FILE);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS drawers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wing TEXT NOT NULL,
      hall TEXT NOT NULL,
      room TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      importance INTEGER NOT NULL DEFAULT 5,
      source_type TEXT,
      source_ref TEXT,
      agent_id TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS drawers_fts USING fts5(
      content, tags, wing, hall, room,
      content='drawers', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS drawers_ai AFTER INSERT ON drawers BEGIN
      INSERT INTO drawers_fts(rowid, content, tags, wing, hall, room)
      VALUES (new.id, new.content, new.tags, new.wing, new.hall, new.room);
    END;

    CREATE TRIGGER IF NOT EXISTS drawers_ad AFTER DELETE ON drawers BEGIN
      INSERT INTO drawers_fts(drawers_fts, rowid, content, tags, wing, hall, room)
      VALUES ('delete', old.id, old.content, old.tags, old.wing, old.hall, old.room);
    END;

    -- No UPDATE trigger: no current task updates FTS-indexed columns (content, tags,
    -- wing, hall, room). Task 129 only updates importance (non-FTS field). If a future
    -- task adds content/tag updates, an UPDATE trigger must be added at that time.
  `);

  registerDb('memory', db);
  _memDb = db;
  return db;
}

export function getMemoryDb(stateDir: string): Database {
  return _memDb ?? initMemoryDb(stateDir);
}

export function closeMemoryDb(): void {
  if (_memDb) {
    unregisterDb('memory');
    _memDb.close();
    _memDb = null;
  }
}
```

### Step 3 — Wire into stateInit.ts

**File:** `lib/stateInit.ts`

Add `initMemoryDb(stateDir)` call alongside existing `initEventsDb(stateDir)`.

### Step 4 — Update AGENTS.md

**File:** `AGENTS.md`

Add `memory.db` to the state files table:

```
| `.orc-state/memory.db` | SQLite memory store (drawers, FTS5 index) |
```

---

## Acceptance criteria

- [ ] `initMemoryDb(stateDir)` creates `memory.db` with `drawers`, `drawers_fts`, and triggers
- [ ] Schema creation is idempotent (calling twice does not error)
- [ ] WAL mode and busy_timeout=5000 are set
- [ ] `closeAllDatabases()` closes the memory DB connection (registered via `registerDb`)
- [ ] `stateInit.ts` calls `initMemoryDb()` at startup
- [ ] AGENTS.md state files table lists `memory.db`
- [ ] `orc doctor` does not flag `memory.db` as unexpected
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('creates memory.db with drawers table and FTS5 index', () => { ... });
it('is idempotent — calling initMemoryDb twice does not error', () => { ... });
it('uses WAL journal mode', () => { ... });
it('registers with closeAllDatabases via registerDb', () => { ... });
```

Add to `lib/eventLog.test.ts`:

```ts
it('registerDb makes a connection visible to closeAllDatabases', () => { ... });
it('unregisterDb removes a connection from the shutdown path', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts lib/eventLog.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: exits 0, memory.db not flagged
```

---

## Risk / Rollback

**Risk:** Adding `registerDb`/`unregisterDb` to eventLog.ts changes the shutdown contract. If a registered DB is already closed externally, `closeAllDatabases()` may double-close.
**Rollback:** `git restore lib/eventLog.ts lib/stateInit.ts AGENTS.md && rm -f lib/memoryStore.ts && npm test`
