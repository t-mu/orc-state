---
ref: publish/99-master-bootstrap-enhancements
feature: publish
priority: normal
status: todo
---

# Task 99 — Enhance Master Bootstrap Template

Independent.

## Scope

**In scope:**
- Fix worktree cleanup ordering (branch delete before worktree remove)
- Add `orc backlog-sync-check` gate after task creation
- Add worker phase awareness to monitoring guidance

**Out of scope:**
- Changing MCP tool descriptions or parameter signatures
- Modifying the notification protocol
- Changing worker or scout bootstrap templates
- Modifying any runtime code (lib/, cli/, coordinator.ts)

---

## Context

An audit of the master bootstrap (`templates/master-bootstrap-v1.txt`) against AGENTS.md found a bug and two missing pieces that affect consumer experience.

### Current state

- Lines 187-189: worktree cleanup runs `git worktree remove` before `git branch -d`. Removing the worktree destroys the shell's cwd, making the subsequent branch delete fail.
- "Planning new work" flow (lines 154-161) registers tasks via `create_task()` but never verifies sync with `orc backlog-sync-check`.
- "Monitoring active work" section has no awareness of the 5 worker phases — master agents can't diagnose which phase a stuck worker is in.

### Desired state

- Worktree cleanup ordering: merge → branch delete → worktree remove (matches AGENTS.md lines 47-58).
- Task creation flow includes `orc backlog-sync-check` verification step.
- Monitoring section explains the 5 worker phases and how to query phase events.

### Start here

- `templates/master-bootstrap-v1.txt` — the only file to modify
- `AGENTS.md` lines 47-58 — correct worktree cleanup ordering

**Affected files:**
- `templates/master-bootstrap-v1.txt` — all changes in this single file

---

## Goals

1. Must fix worktree cleanup to delete branch before removing worktree.
2. Must add `orc backlog-sync-check` to the task creation flow.
3. Must document the 5 worker phases (explore, implement, review, complete, finalize) in the monitoring section.

---

## Implementation

### Step 1 — Fix worktree cleanup ordering

**File:** `templates/master-bootstrap-v1.txt`

Replace lines 187-189:

```
  git -C ../.. merge master/<slug> --no-ff -m "task(<slug>): merge worktree"
  git worktree remove .worktrees/master-<slug>
  git branch -d master/<slug>
```

With:

```
  git -C ../.. merge master/<slug> --no-ff -m "task(<slug>): merge worktree"
  git branch -d master/<slug>
  git worktree remove .worktrees/master-<slug>
```

### Step 2 — Add backlog-sync-check to task creation flow

**File:** `templates/master-bootstrap-v1.txt`

In the "Planning new work" section (after step 2 where `create_task(...)` is called), insert:

```
   Run `orc backlog-sync-check` to verify runtime state matches the markdown spec.
```

### Step 3 — Add worker phase awareness

**File:** `templates/master-bootstrap-v1.txt`

Add to the "Monitoring active work" section (after the existing 5 numbered steps):

```
Workers follow five phases: explore → implement → review → complete → finalize.
Phase progress is visible via get_recent_events() or query_events(event_type="phase_started").
A worker stuck in "implement" may need different help than one stuck in "review" —
use phase context to diagnose stalls before intervening.
```

---

## Acceptance criteria

- [ ] Worktree cleanup ordering is: merge → `git branch -d` → `git worktree remove`.
- [ ] `orc backlog-sync-check` appears in the "Planning new work" flow after `create_task`.
- [ ] Worker phases (explore, implement, review, complete, finalize) documented in monitoring section.
- [ ] `query_events(event_type="phase_started")` mentioned as the query method.
- [ ] No changes to MCP tool descriptions, notification protocol, or status display format.
- [ ] `npm test` passes.
- [ ] No changes to files outside `templates/master-bootstrap-v1.txt`.

---

## Tests

No new unit tests required. Validation via content inspection and existing tests passing.

---

## Verification

```bash
# Verify cleanup ordering: branch -d must appear before worktree remove
grep -n 'branch -d\|worktree remove' templates/master-bootstrap-v1.txt

# Verify backlog-sync-check present
grep 'backlog-sync-check' templates/master-bootstrap-v1.txt

# Verify phase awareness present
grep 'explore.*implement.*review.*complete.*finalize' templates/master-bootstrap-v1.txt

# Full suite
nvm use 24 && npm test
```
