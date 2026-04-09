---
ref: general/156-docs-recovery-expand
feature: general
priority: normal
status: done
---

# Task 156 — Expand docs/recovery.md Operational Recovery Guide

Independent.

## Scope

**In scope:**
- Add missing recovery scenarios to `docs/recovery.md`
- Define boundary between `recovery.md` and `troubleshooting.md`
- Add cross-links between the two docs
- Audit `troubleshooting.md` for multi-step procedures that belong in recovery.md

**Out of scope:**
- Rewriting existing recovery scenarios (keep the 3 that exist)
- Modifying troubleshooting.md content beyond adding a cross-link header
- Changing any CLI commands or code

---

## Context

`docs/recovery.md` covers 3 scenarios: finalization failure, hung input
request, and session start failure. These are well-written but the doc is
incomplete for common operational situations.

`docs/troubleshooting.md` covers overlapping ground with a mix
of single-symptom Q&A items and multi-step procedural fixes. The boundary
between the two docs is unclear.

**Defined boundary:**
- `troubleshooting.md` = single-symptom Q&A: "I see X error → do Y"
- `recovery.md` = multi-step operational procedures requiring judgment and
  multiple commands

**Start here:** `docs/recovery.md`

**Affected files:**
- `docs/recovery.md` — add scenarios and boundary header
- `docs/troubleshooting.md` — add cross-link header (one line only)

---

## Goals

1. Must add recovery procedures for: stale workers, stuck/orphaned worktrees, blocked tasks, and full system reset.
2. Must define the boundary between recovery.md and troubleshooting.md at the top of each file.
3. Must cross-link between the two docs.
4. Must audit troubleshooting.md for multi-step procedures and migrate them to recovery.md if appropriate.
5. Must keep the existing 3 recovery scenarios intact.
6. Must use the symptom → diagnosis → fix format consistently.

---

## Implementation

### Step 1 — Add boundary header to recovery.md

**File:** `docs/recovery.md`

Add after line 1 heading:

```markdown
This guide covers multi-step operational recovery procedures. For quick
single-symptom fixes, see [Troubleshooting](./troubleshooting.md).
```

### Step 2 — Add missing recovery scenarios

**File:** `docs/recovery.md`

Add after the existing 3 scenarios:

**Stale Workers:**
- Symptoms: `orc status` shows workers that aren't doing anything, `orc doctor` reports stale workers
- Diagnosis: `orc worker-status <id>`
- Fix: `orc worker-gc` to mark stale, `orc worker-clearall` to remove

**Stuck/Orphaned Worktrees:**
- Symptoms: `.worktrees/` has directories for runs that finished or failed
- Diagnosis: `git worktree list`, compare with `orc runs-active`
- Fix: `git worktree remove .worktrees/<dir>` for orphaned entries

**Blocked Tasks:**
- Symptoms: `orc backlog-blocked` shows tasks that should be runnable
- Diagnosis: check `depends_on` in the task spec, check if dependency task is done
- Fix: `orc task-unblock <ref>` if manually blocked, or complete the dependency

**Full System Reset:**
- When: everything is broken, you want a clean slate
- Steps: `orc kill-all`, optionally reinitialize with `orc init --force`
- Warning: this stops all work in progress

### Step 3 — Add cross-link to troubleshooting.md

**File:** `docs/troubleshooting.md`

Add after line 1 heading:

```markdown
For multi-step recovery procedures, see [Recovery guide](./recovery.md).
```

### Step 4 — Audit troubleshooting.md for migrations

Read `docs/troubleshooting.md` and identify any entries that are multi-step
procedures rather than single-symptom Q&A. If found, move them to recovery.md
and leave a link in troubleshooting.md pointing to the new location.

---

## Acceptance criteria

- [ ] recovery.md has at least 7 scenarios (3 existing + 4 new).
- [ ] Boundary between recovery.md and troubleshooting.md is defined at the top of each.
- [ ] Cross-links exist in both directions.
- [ ] Each new scenario follows symptom → diagnosis → fix format.
- [ ] Existing 3 scenarios are unchanged.
- [ ] troubleshooting.md has a cross-link header but is otherwise not rewritten.
- [ ] No changes to files outside the stated scope.

---

## Tests

No code tests — documentation only.

---

## Verification

```bash
test -s docs/recovery.md && echo "OK"
grep -c "^##" docs/recovery.md  # should be >= 7 (heading per scenario)
```
