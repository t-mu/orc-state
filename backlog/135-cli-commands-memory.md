---
ref: memory-access/135-cli-commands-memory
feature: memory-access
priority: normal
status: todo
depends_on:
  - memory-foundation/131-fts5-search-spatial-filtering
  - memory-foundation/132-spatial-taxonomy-queries
  - memory-access/133-memory-wake-up-essential-recall
---

# Task 135 — Add CLI Commands for Memory

Depends on Tasks 131, 132, and 133. Blocks Task 136.

## Scope

**In scope:**
- 4 new CLI commands: `memory-status`, `memory-search`, `memory-wake-up`, `memory-record`
- Registration in `cli/orc.ts` command map with correct categories
- Update AGENTS.md Blessed Paths and Commands sections

**Out of scope:**
- MCP tool implementation (Task 134)
- Bootstrap template changes (Task 136)

---

## Context

### Current state

The `cli/orc.ts` dispatcher maps subcommand names to TS files in `cli/`. Commands are
categorized into BLESSED, INSPECTION, and RECOVERY_DEBUG arrays. There are no memory
commands.

### Desired state

Four memory CLI commands are available: `memory-status` and `memory-search` for inspection,
`memory-wake-up` and `memory-record` as blessed worker lifecycle commands. AGENTS.md
documents them in the Commands section.

### Start here

- `cli/orc.ts` — command dispatch map and category arrays
- `cli/status.ts` — reference for CLI command implementation pattern
- `AGENTS.md` — Blessed Paths and Commands sections

**Affected files:**
- `cli/memory-status.ts` — new: print memory stats
- `cli/memory-search.ts` — new: FTS5 search
- `cli/memory-wake-up.ts` — new: print wake-up text
- `cli/memory-record.ts` — new: store a memory
- `cli/orc.ts` — register commands and categories
- `AGENTS.md` — update Commands section

---

## Goals

1. Must add `orc memory-status` to INSPECTION category.
2. Must add `orc memory-search <query> [--wing=X] [--room=Y]` to INSPECTION category.
3. Must add `orc memory-wake-up [--wing=X] [--budget=N]` to BLESSED category.
4. Must add `orc memory-record --content="..." [--wing=X] [--hall=Y] [--room=Z] [--importance=N]` to BLESSED category.
5. Must update AGENTS.md Blessed Paths and Commands sections.
6. Must exit 0 with informative message when memory.db doesn't exist.

---

## Implementation

### Step 1 — Create CLI command files

**Files:** `cli/memory-status.ts`, `cli/memory-search.ts`, `cli/memory-wake-up.ts`, `cli/memory-record.ts`

Each file follows the existing pattern: parse args with `lib/args.ts` helpers, call the corresponding `lib/memoryStore.ts` function, print output, exit.

`memory-wake-up` must exit 0 with empty output when memory.db doesn't exist (non-fatal for worker bootstrap).

### Step 2 — Register in orc.ts

**File:** `cli/orc.ts`

Add to COMMANDS map:
```ts
'memory-status': 'memory-status.ts',
'memory-search': 'memory-search.ts',
'memory-wake-up': 'memory-wake-up.ts',
'memory-record': 'memory-record.ts',
```

Add `memory-status` and `memory-search` to INSPECTION array.
Add `memory-wake-up` and `memory-record` to BLESSED array.

### Step 3 — Update AGENTS.md

**File:** `AGENTS.md`

Add to Commands section under Blessed:
```
orc memory-wake-up [--wing=X] [--budget=N]        # recall essential memories at session start
orc memory-record --content="..." [--wing=X] ...   # store a memory
```

Add to Commands section under Inspection:
```
orc memory-status                                   # memory store stats
orc memory-search <query> [--wing=X] [--room=Y]   # search memories
```

---

## Acceptance criteria

- [ ] `orc memory-status` prints drawer count, wing breakdown, DB size
- [ ] `orc memory-search "query"` prints FTS5 results with snippets
- [ ] `orc memory-wake-up` prints formatted wake-up text
- [ ] `orc memory-record --content="test"` stores a drawer and prints ID
- [ ] All commands exit 0 with informative message when memory.db doesn't exist
- [ ] Commands appear in `orc --help` under correct categories
- [ ] AGENTS.md Commands section lists all 4 memory commands
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `cli/memory-status.test.ts`:

```ts
it('prints memory stats', () => { ... });
it('exits 0 with info message when memory.db missing', () => { ... });
```

Add to `cli/memory-record.test.ts`:

```ts
it('stores a drawer and prints the ID', () => { ... });
it('uses --wing and --room flags', () => { ... });
```

---

## Verification

```bash
npx vitest run cli/memory-status.test.ts cli/memory-record.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
orc memory-status
# Expected: exits 0
```

---

## Risk / Rollback

**Risk:** Adding commands to BLESSED array changes the help output ordering.
**Rollback:** `git restore cli/orc.ts AGENTS.md && rm -f cli/memory-*.ts && npm test`
