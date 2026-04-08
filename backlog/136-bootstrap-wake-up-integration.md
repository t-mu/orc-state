---
ref: memory-access/136-bootstrap-wake-up-integration
feature: memory-access
priority: normal
status: todo
depends_on:
  - memory-access/134-mcp-tools-memory-access
  - memory-access/135-cli-commands-memory
---

# Task 136 — Integrate Memory Wake-Up into Worker Bootstrap

Depends on Tasks 134 and 135.

## Scope

**In scope:**
- Modify `templates/worker-bootstrap-v2.txt` to call `orc memory-wake-up` after TASK_START
- Instruct workers to use `orc memory-record` during implementation
- Instruct workers to use `memory_recall` MCP tool for unfamiliar code areas

**Out of scope:**
- Memory store implementation (Phase 1)
- MCP tool or CLI command implementation (Tasks 134, 135)
- Event-driven ingestion (Task 137)

---

## Context

### Current state

The worker bootstrap template (`templates/worker-bootstrap-v2.txt`) defines the 5-phase
lifecycle but has no memory integration. Workers start every session with zero knowledge
of past sessions.

### Desired state

Workers call `orc memory-wake-up --wing=<feature>` after TASK_START arrives (when they
know their task_ref and can derive the feature wing). The wake-up output provides spatial-filtered
essential memories for their task's domain. Workers are instructed to store discoveries
via `orc memory-record` during implementation.

### Start here

- `templates/worker-bootstrap-v2.txt` — the bootstrap template
- `lib/templateRender.ts` — how templates are rendered with variables

**Affected files:**
- `templates/worker-bootstrap-v2.txt` — add memory wake-up and record instructions

---

## Goals

1. Must call `orc memory-wake-up --wing=<feature>` after TASK_START arrives, before explore phase.
2. Must derive wing from the task_ref feature prefix (e.g., `memory-foundation/128-*` → `memory-foundation`).
3. Must be non-fatal: if `orc memory-wake-up` fails or returns empty, worker proceeds normally.
4. Must instruct workers to call `orc memory-record` for significant discoveries during implementation.
5. Must not break workers on fresh installs where memory.db doesn't exist.

---

## Implementation

### Step 1 — Add memory wake-up to bootstrap template

**File:** `templates/worker-bootstrap-v2.txt`

Insert after the TASK_START handling block (after `cd` to worktree, before phase explore):

```
  3.5. Load relevant memories for this task's domain (non-fatal — skip if unavailable):
       WING=$(echo "<task_ref>" | cut -d'/' -f1)
       {{orc_bin}} memory-wake-up --wing="$WING" 2>/dev/null || true
       # If the above returned content, it contains past discoveries, errors, and
       # decisions relevant to this domain. Use it to avoid re-discovering known issues.
```

### Step 2 — Add memory-record instruction in implement phase

**File:** `templates/worker-bootstrap-v2.txt`

Add to the implement phase (step 4) documentation:

```
     When you discover a significant pattern, error, or decision during implementation,
     record it for future sessions:
       {{orc_bin}} memory-record --content="<description>" --wing="$WING" --hall=<category> --room=<topic>
     Categories: errors, decisions, patterns, observations. This is optional but valuable.
```

### Step 3 — Add memory_recall instruction for unfamiliar areas

Add a note in the explore phase:

```
     If working in an unfamiliar code area, check for relevant memories:
       Use the memory_recall MCP tool with the wing matching the task's feature.
```

---

## Acceptance criteria

- [ ] Bootstrap template includes memory-wake-up call after TASK_START
- [ ] Wake-up call derives wing from task_ref feature prefix
- [ ] Wake-up call is wrapped with `|| true` so failure doesn't block the worker
- [ ] Bootstrap template instructs workers to use `orc memory-record` during implementation
- [ ] Workers on fresh install (no memory.db) start normally with no errors
- [ ] Template renders correctly with `{{orc_bin}}` variable substitution
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/sessionBootstrap.test.ts`:

```ts
it('rendered bootstrap contains memory-wake-up call', () => { ... });
it('memory-wake-up call includes wing variable derived from task_ref', () => { ... });
it('memory-wake-up call is non-fatal (wrapped with || true)', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/templateRender.test.ts lib/sessionBootstrap.test.ts
```

```bash
nvm use 24 && npm test
```
