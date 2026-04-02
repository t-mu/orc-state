---
ref: publish/113-consolidate-and-fix-master-bootstrap
feature: publish
priority: high
status: todo
---

# Task 113 — Consolidate Provider Master Bootstraps and Fix Inaccuracies

Independent.

## Scope

**In scope:**
- Delete `templates/master-bootstrap-codex-v1.txt` and `templates/master-bootstrap-gemini-v1.txt`
- Update `lib/sessionBootstrap.ts` to use `master-bootstrap-v1.txt` for all providers
- Fix 9 inaccuracies in `templates/master-bootstrap-v1.txt` (detailed below)
- Update any tests that reference the deleted templates

**Out of scope:**
- Changing worker or scout bootstrap templates
- Modifying MCP tool implementations or handler code
- Adding provider-specific conditional logic (if ever needed, it will be loaded dynamically — not via separate template files)
- Changing coordinator dispatch logic

---

## Context

The master bootstrap has three provider-specific copies: Claude (`master-bootstrap-v1.txt`), Codex (`master-bootstrap-codex-v1.txt`), and Gemini (`master-bootstrap-gemini-v1.txt`). The Codex and Gemini variants are incomplete copies that fell behind — they're missing 7 MCP tools (`get_run`, `list_waiting_input`, `query_events`, `list_worktrees`, `cancel_task`, `respond_input`, `reset_task`). The only real difference is a Codex hedge about MCP availability, which is no longer needed since MCP is configured for all providers.

Additionally, a critic review of the Claude variant found 9 factual inaccuracies against the actual MCP tool schemas and coordinator behavior.

### Current state

- Three master bootstrap files, two out of sync with reality
- `lib/sessionBootstrap.ts` selects template by provider name
- Claude variant has inaccurate tool signatures, wrong defaults, and missing params
- No mention of autonomous dispatch mode

### Desired state

- Single `master-bootstrap-v1.txt` used for all providers
- All MCP tool signatures match `mcp/tools-list.ts` exactly
- Autonomous dispatch documented
- Stale internal references removed

### Start here

- `templates/master-bootstrap-v1.txt` — the source of truth to fix
- `templates/master-bootstrap-codex-v1.txt` — to delete
- `templates/master-bootstrap-gemini-v1.txt` — to delete
- `lib/sessionBootstrap.ts` — template selection logic
- `mcp/tools-list.ts` — actual tool schemas for cross-checking

**Affected files:**
- `templates/master-bootstrap-v1.txt` — fix 9 inaccuracies
- `templates/master-bootstrap-codex-v1.txt` — delete
- `templates/master-bootstrap-gemini-v1.txt` — delete
- `lib/sessionBootstrap.ts` — remove provider-based template selection for master
- Test files referencing deleted templates (if any)

---

## Goals

1. Must delete `master-bootstrap-codex-v1.txt` and `master-bootstrap-gemini-v1.txt`.
2. Must update `lib/sessionBootstrap.ts` to use `master-bootstrap-v1.txt` for all providers.
3. Must fix `get_recent_events` default from 50 to 20.
4. Must fix `create_task` signature — `title` is the only required field, `feature` defaults to `"general"`, add missing params `priority`, `required_provider`, `ref`.
5. Must fix default feature in INVARIANTS from `orch` to `general`.
6. Must add autonomous dispatch awareness to the "Planning new work" flow.
7. Must add `fts_query` param to `query_events` and `include_dead` param to `list_agents`.
8. Must add `next_task_seq` to `get_status` return shape description.
9. Must replace `sort -V` task numbering with `get_status().next_task_seq`.
10. Must remove the stale deprecation warning about "deprecated text-extraction protocol".
11. Must pass `npm test`.

---

## Implementation

### Step 1 — Delete provider-specific master bootstraps

**Files:** `templates/master-bootstrap-codex-v1.txt`, `templates/master-bootstrap-gemini-v1.txt`

```bash
git rm templates/master-bootstrap-codex-v1.txt templates/master-bootstrap-gemini-v1.txt
```

### Step 2 — Update sessionBootstrap.ts

**File:** `lib/sessionBootstrap.ts`

Find where `getMasterBootstrap` (or equivalent) selects the template based on provider. Change it to always use `master-bootstrap-v1.txt` regardless of provider argument.

Before:
```ts
// Something like:
const template = provider === 'codex' ? 'master-bootstrap-codex-v1.txt'
  : provider === 'gemini' ? 'master-bootstrap-gemini-v1.txt'
  : 'master-bootstrap-v1.txt';
```

After:
```ts
const template = 'master-bootstrap-v1.txt';
```

### Step 3 — Fix get_recent_events default

**File:** `templates/master-bootstrap-v1.txt`

Change `Default 50, max 200` → `Default 20, max 200`

### Step 4 — Fix create_task signature

**File:** `templates/master-bootstrap-v1.txt`

Replace:
```
create_task(feature, title, task_type?, required_capabilities?, owner?, ref?, actor_id?)
  Registers a task in the runtime dispatch backlog (state/backlog.json).
  Use ONLY for tasks that already have a spec in backlog/ and are ready
  to be picked up by a worker. Markdown-owned fields must already live in the
  spec; do not pass description, acceptance_criteria, or depends_on here.
  task_type: implementation|refactor (default implementation).
  actor_id defaults to {{agent_id}}.
```

With:
```
create_task(title, feature?, ref?, task_type?, priority?, required_provider?, required_capabilities?, owner?, actor_id?)
  Registers a task in the runtime dispatch backlog (state/backlog.json).
  title is the only required field. feature defaults to "general".
  ref: explicit slug matching the markdown spec filename.
  Use ONLY for tasks that already have a spec in backlog/.
  Markdown-owned fields (description, acceptance_criteria, depends_on)
  must live in the spec; do not pass them here.
  task_type: implementation|refactor (default implementation).
  priority: low|normal|high|critical (default normal).
  required_provider: restrict dispatch to codex|claude|gemini.
  actor_id defaults to {{agent_id}}.
```

### Step 5 — Fix default feature in INVARIANTS

**File:** `templates/master-bootstrap-v1.txt`

Change `Default feature is orch.` → `Default feature is general.`

### Step 6 — Add autonomous dispatch awareness

**File:** `templates/master-bootstrap-v1.txt`

In the "Planning new work" section, after step 2 (create_task + sync-check), add:

```
Note: in autonomous mode (the default), the coordinator auto-dispatches
eligible tasks to available workers on each tick. You do not need to call
delegate_task() unless you want to target a specific worker or the
coordinator is not running in autonomous mode. Skip steps 3-4 when
autonomous dispatch is active.
```

### Step 7 — Add missing params to query_events and list_agents

**File:** `templates/master-bootstrap-v1.txt`

Change `query_events(run_id?, agent_id?, event_type?, after_seq?, limit?)` to:
```
query_events(run_id?, agent_id?, event_type?, after_seq?, limit?, fts_query?)
  Query the SQLite events database with optional AND-combined filters.
  Default limit 50, max 500.
  fts_query: full-text search against event payloads (FTS5 syntax).
```

Change `list_agents(role?)` to:
```
list_agents(role?, include_dead?)
  Returns registered agents. role: worker|reviewer|master|scout.
  include_dead: include agents with status=dead (default: false).
```

### Step 8 — Add next_task_seq to get_status

**File:** `templates/master-bootstrap-v1.txt`

Change:
```
Returns compact aggregate status (agents, task_counts, active_tasks,
last_notification_seq, stalled_runs).
```
To:
```
Returns compact aggregate status (agents, task_counts, active_tasks,
last_notification_seq, stalled_runs, next_task_seq).
```

### Step 9 — Fix task numbering command

**File:** `templates/master-bootstrap-v1.txt`

In "Planning new work" step 1, replace:
```
Assign the next available number (ls backlog/*.md | sort -V | tail -1).
```
With:
```
Use get_status().next_task_seq for the next available task number.
```

### Step 10 — Remove stale deprecation warning

**File:** `templates/master-bootstrap-v1.txt`

Remove lines 15-16:
```
- Use PTY-session and CLI-reporting terminology only; do not describe any
  deprecated text-extraction protocol as the active runtime path.
```

---

## Acceptance criteria

- [ ] `templates/master-bootstrap-codex-v1.txt` does not exist.
- [ ] `templates/master-bootstrap-gemini-v1.txt` does not exist.
- [ ] `lib/sessionBootstrap.ts` uses `master-bootstrap-v1.txt` for all providers.
- [ ] `get_recent_events` shows "Default 20" not "Default 50".
- [ ] `create_task` signature has `title` as first param, `feature` as optional defaulting to "general".
- [ ] INVARIANTS says "Default feature is general" not "orch".
- [ ] Autonomous dispatch is documented in "Planning new work".
- [ ] `query_events` includes `fts_query` param.
- [ ] `list_agents` includes `include_dead` param.
- [ ] `get_status` return shape includes `next_task_seq`.
- [ ] Task numbering uses `get_status().next_task_seq` not `sort -V`.
- [ ] No reference to "deprecated text-extraction protocol".
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Existing `lib/sessionBootstrap.test.ts` must pass. If it tests provider-specific template selection, update the tests to expect the consolidated template for all providers.

Check for references to deleted templates in test files:
```bash
grep -r 'master-bootstrap-codex\|master-bootstrap-gemini' --include='*.ts' .
```

---

## Verification

```bash
# Verify deleted templates
ls templates/master-bootstrap-codex-v1.txt 2>&1 | grep -q "No such file" && echo "PASS: codex deleted"
ls templates/master-bootstrap-gemini-v1.txt 2>&1 | grep -q "No such file" && echo "PASS: gemini deleted"

# Verify fixes in the remaining template
grep 'Default 20' templates/master-bootstrap-v1.txt && echo "PASS: events default"
grep 'Default feature is general' templates/master-bootstrap-v1.txt && echo "PASS: default feature"
grep 'autonomous' templates/master-bootstrap-v1.txt && echo "PASS: auto-dispatch"
grep 'fts_query' templates/master-bootstrap-v1.txt && echo "PASS: fts_query"
grep 'include_dead' templates/master-bootstrap-v1.txt && echo "PASS: include_dead"
grep 'next_task_seq' templates/master-bootstrap-v1.txt && echo "PASS: next_task_seq"
grep -c 'deprecated text-extraction' templates/master-bootstrap-v1.txt
# Expected: 0

# Full suite
nvm use 24 && npm test
```
