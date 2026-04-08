# Memory System

The orchestrator's memory system gives worker agents persistent, searchable knowledge that
survives across sessions. Workers record discoveries, decisions, and errors during task
execution; future sessions recall that knowledge at startup to avoid re-discovering the same
ground.

---

## Overview

Memory solves a key problem with stateless agent sessions: each worker PTY starts cold.
Without persistence, every session must re-read the same files, re-discover the same
patterns, and re-encounter the same errors. The memory system provides a lightweight
SQLite store that workers write to during a run and read from at session start.

Key properties:

- **Full-text search** — FTS5 index on content and tags enables fast keyword queries.
- **Importance weighting** — each memory has an importance score (1–10); higher importance
  floats to the top of search results and wake-up recall.
- **Spatial organization** — memories are filed in a three-level hierarchy (wing / hall / room)
  that maps naturally to the feature/category/topic structure of the project backlog.
- **Automatic expiry** — memories can carry an `expires_at` timestamp; the prune command
  removes stale entries.
- **Duplicate detection** — content is hashed; inserting the same content twice returns
  the existing ID without creating a second row.

---

## Architecture

### Storage

Memory is stored in `.orc-state/memory.db`, a SQLite database managed by `lib/memoryStore.ts`.
The coordinator initializes the database on first use. Workers never write to the file
directly — all access goes through the `orc` CLI or MCP tools.

### Schema

The `drawers` table holds one memory per row:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `wing` | TEXT | Top-level spatial coordinate (feature name) |
| `hall` | TEXT | Mid-level coordinate (category) |
| `room` | TEXT | Fine-grained coordinate (topic) |
| `content` | TEXT | The memory text |
| `content_hash` | TEXT | SHA-256 of normalized content (deduplication key) |
| `importance` | INTEGER | Relevance score 1–10; default 5 |
| `source_type` | TEXT | Origin: `event`, `cli`, `mcp`, etc. |
| `source_ref` | TEXT | Run ID or other external reference |
| `agent_id` | TEXT | Agent that created this memory |
| `tags` | TEXT | Comma-separated keywords (auto-extracted if not provided) |
| `created_at` | TEXT | ISO 8601 creation timestamp |
| `expires_at` | TEXT | ISO 8601 expiry timestamp, or NULL for permanent |

### FTS5 Full-Text Index

A virtual table `drawers_fts` mirrors the `content`, `tags`, `wing`, `hall`, and `room`
columns of `drawers`. INSERT and DELETE triggers keep the FTS index in sync automatically.

Search uses BM25 relevance scoring multiplied by the importance factor:

```
rank = bm25(drawers_fts) × (importance / 10.0)
```

Because BM25 returns negative values, lower rank (more negative) means a better match.
Results are ordered ascending by rank so the most relevant, highest-importance memories
appear first.

### WAL Mode

The database runs in WAL journal mode (`journal_mode = WAL`) with a 5-second busy timeout.
WAL allows concurrent reads while a write is in progress. The `orc doctor` command checks
the WAL file size and warns if it grows above 50 MB.

---

## Spatial Organization

Memories are filed in a three-level hierarchy that mirrors the project backlog structure:

```
wing / hall / room
 ↑       ↑      ↑
feature category topic
```

### Wing

The top-level namespace. A wing corresponds to a **feature group** from the backlog
(`memory-quality`, `memory-access`, `memory-foundation`, etc.). Workers derive the wing
from their task ref automatically:

```bash
orc memory-record --content="..." --wing=memory-quality ...
```

The helper function `wingFromTaskRef('memory-quality/140-integration-tests')` returns
`'memory-quality'`. Without a slash, it returns `'general'`.

### Hall

The mid-level namespace representing a **category** of knowledge within a wing. Common
values used by workers and the coordinator:

| Hall | What goes here |
|------|----------------|
| `patterns` | Coding patterns, conventions, observed architecture |
| `decisions` | Choices made and why |
| `errors` | Errors encountered and how they were resolved |
| `observations` | Neutral observations about the codebase |
| `outcomes` | Task completions, milestone records |

### Room

The fine-grained topic within a hall. Examples: `typescript`, `database`, `lifecycle`,
`task-completions`, `run-failures`. Use short, hyphenated slugs.

### Choosing coordinates

When recording a memory, choose coordinates that will help future sessions find it:

- `wing` — always match the feature group of the task you are working on.
- `hall` — pick the category that best describes the *type* of knowledge.
- `room` — pick the topic that best describes the *subject* of the knowledge.

A future session searching for knowledge about database errors in the memory-quality
feature would query `wing=memory-quality hall=errors`.

---

## CLI Reference

### `orc memory-status`

Print statistics about the memory store.

```
Usage: orc memory-status

Output:
  Drawers: <total count>
  Wings:   <distinct wing count>
  Rooms:   <distinct room count>
  DB size: <KB>
  Oldest:  <ISO timestamp>
  Newest:  <ISO timestamp>

  Wing breakdown:
    <wing>: <count>
    ...
```

Exits 0 with an informative message if `memory.db` does not exist.

---

### `orc memory-search <query>`

Search memories by full-text query. Results are ordered by importance-weighted BM25 rank
(most relevant and highest importance first).

```
Usage: orc memory-search <query> [--wing=X] [--room=Y]

Options:
  --wing=X    Filter results to a specific wing
  --room=Y    Filter results to a specific room

Output (per result):
  [<id>] <wing>/<hall>/<room> (importance=<N>)
    <snippet up to 200 chars>
```

Exits 0 with "No results found." when there are no matches or `memory.db` is absent.

---

### `orc memory-wake-up`

Recall essential memories at session start. Outputs the highest-importance memories
up to a token budget, formatted with wing/room headers.

```
Usage: orc memory-wake-up [--wing=X] [--budget=N]

Options:
  --wing=X     Restrict recall to a specific wing
  --budget=N   Token budget (default: 800; 1 token ≈ 4 characters)

Output format:
  ## <wing> / <room>

  - <memory content>
  - <memory content>

  ## <wing> / <room>

  - <memory content>
```

Exits 0 silently (no output) when `memory.db` is absent or contains no memories.

---

### `orc memory-record`

Store a new memory. If content is identical to an existing memory, returns the existing
drawer ID without creating a duplicate.

```
Usage: orc memory-record --content="..." [--wing=X] [--hall=Y] [--room=Z] [--importance=N]

Options:
  --content="..."   Required. The memory text to store.
  --wing=X          Wing (feature group). Default: general.
  --hall=Y          Hall (category). Default: default.
  --room=Z          Room (topic). Default: default.
  --importance=N    Importance score 1–10. Default: 5.

Output:
  stored: drawer <id>
```

Exits 0 with an informative message if `memory.db` does not exist.

---

## MCP Tools

The memory system is also accessible to master agents through MCP tools. All tools are
defined in `mcp/handlers.ts` and registered with the MCP server.

### `memory_wake_up`

Equivalent to `orc memory-wake-up`. Returns formatted memory text up to a token budget.

```json
{
  "name": "memory_wake_up",
  "arguments": {
    "wing": "memory-quality",   // optional
    "budget": 800               // optional, default 800
  }
}
```

Returns `{ text: "## wing / room\n\n- content\n..." }` or `{ text: "" }` when empty.

---

### `memory_recall`

List drawers from a specific wing, optionally filtered by room. Returns structured JSON.
Use this when you know the spatial location and want to browse its contents.

```json
{
  "name": "memory_recall",
  "arguments": {
    "wing": "memory-foundation",  // required
    "room": "database",           // optional
    "limit": 10                   // optional
  }
}
```

Returns `{ drawers: [{ id, wing, hall, room, content, content_hash, importance, source_type, source_ref, agent_id, tags, created_at, expires_at }] }`.

---

### `memory_search`

Full-text search across memories using FTS5. Equivalent to `orc memory-search` but returns
structured JSON. Use this when you want to find memories by keyword.

```json
{
  "name": "memory_search",
  "arguments": {
    "query": "sqlite busy_timeout",  // required
    "wing": "memory-foundation",     // optional
    "room": "database",              // optional
    "limit": 5                       // optional, default 10
  }
}
```

Returns `{ results: [{ id, snippet, wing, hall, room, importance, created_at, rank }] }`.

---

### `memory_store`

Store a new memory. Equivalent to `orc memory-record`.

```json
{
  "name": "memory_store",
  "arguments": {
    "content": "The memory text to store",  // required
    "wing": "memory-quality",               // optional, default: general
    "hall": "decisions",                    // optional, default: default
    "room": "schema",                       // optional, default: default
    "importance": 7,                        // optional, default: 5
    "sourceType": "event",                  // optional
    "sourceRef": "run-20260408130451-aa73"  // optional
  }
}
```

Returns `{ id: <drawer_id> }`.

---

### `memory_status`

Returns memory store statistics. Equivalent to `orc memory-status`.

```json
{
  "name": "memory_status",
  "arguments": {}
}
```

Returns `{ stats: { totalDrawers, distinctWings, distinctRooms, oldestMemory, newestMemory, dbSizeBytes } }`.

---

## Worker Integration

### Session Start — Wake-Up

At the start of every task session, workers load relevant memories before beginning
implementation. The bootstrap protocol specifies:

```bash
WING=$(echo "<task_ref>" | cut -d'/' -f1)
/home/node/.npm-global/bin/orc memory-wake-up --wing="$WING" 2>/dev/null || true
```

This is a non-fatal operation — if the memory store is absent or empty, the command
exits 0 with no output and the worker continues normally.

For targeted queries during exploration of unfamiliar code:

```bash
# via MCP — search by keyword (master or worker with MCP access):
memory_search({ query: "sqlite schema", wing: "memory-foundation" })

# via MCP — list all drawers in a wing/room:
memory_recall({ wing: "memory-foundation", room: "database" })
```

### During Implementation — Recording Memories

When a worker discovers a significant pattern, error, or decision, it should record it
so future sessions benefit:

```bash
orc memory-record \
  --content="better-sqlite3 synchronous API means no async/await needed in query helpers" \
  --wing=memory-foundation \
  --hall=patterns \
  --room=sqlite \
  --importance=7
```

Good memories to record:

- Non-obvious patterns discovered while reading the code
- Errors encountered and their root cause
- Architectural decisions and the reasoning behind them
- Gotchas that would have saved time if known upfront

Do not record things that are obvious from reading the code, or information that is
already in CLAUDE.md or AGENTS.md.

---

## Automatic Ingestion

The coordinator automatically records memories from run lifecycle events. No worker
action is required.

### On `run_finished`

When a run completes successfully, the coordinator stores:

```
wing:  <feature group from task_ref>
hall:  outcomes
room:  task-completions
content: Task <task_ref> completed by <agent_id> (run <run_id>)
importance: 5
source_type: event
```

### On `run_failed`

When a run fails, the coordinator stores:

```
wing:  <feature group from task_ref>
hall:  errors
room:  run-failures
content: Task <task_ref> failed (run <run_id>): <reason>
importance: 8
source_type: event
```

Failure memories carry higher importance (8) so they surface prominently during
wake-up, helping future workers avoid repeating the same mistake.

### From Review Submissions

When a reviewer submits findings via `orc review-submit`, the outcome is recorded in
the memory store for the run's feature wing.

### From Input Responses

When the master responds to a `run-input-request`, the response is recorded as a
memory so the decision is preserved for future sessions.

---

## Maintenance

### Pruning Expired Memories

Remove memories past their `expires_at` timestamp:

```bash
# Not directly exposed as a standalone CLI command.
# Pruning is invoked internally by the coordinator on its maintenance tick.
# Workers with expiring content set expires_at when calling storeDrawer.
```

Programmatically (from coordinator/test code):

```ts
import { pruneExpiredMemories } from './lib/memoryStore.ts';
const deleted = pruneExpiredMemories(stateDir);
```

### Pruning by Capacity

Each room is capped at a configurable maximum number of drawers. When a room exceeds
the cap, the lowest-importance entries are deleted:

```ts
import { pruneByCapacity } from './lib/memoryStore.ts';
const deleted = pruneByCapacity(stateDir, 200); // keep top 200 per room
```

The coordinator runs capacity pruning on each maintenance tick to prevent unbounded growth.

### Doctor Checks

`orc doctor` validates the memory store health:

- Verifies `memory.db` exists and is readable (if the store has been initialized).
- Checks the WAL file size; warns if it exceeds 50 MB.
- Reports total drawer count and DB size.

```bash
orc doctor
# Expected output includes:
#   memory: ok (N drawers, X.X KB)
```
