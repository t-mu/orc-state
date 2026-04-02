---
ref: publish/100-sync-provider-master-bootstraps
feature: publish
priority: normal
status: done
depends_on:
  - publish/99-master-bootstrap-enhancements
---

# Task 100 — Sync Provider-Specific Master Bootstraps with Claude Variant

Depends on Task 99 (master bootstrap changes must be finalized first).

## Scope

**In scope:**
- Apply worktree cleanup ordering fix to Codex and Gemini master bootstraps
- Apply `orc backlog-sync-check` task creation gate to both
- Apply worker phase awareness to both

**Out of scope:**
- Changing provider-specific content (Codex/Gemini-unique sections)
- Modifying the Claude master bootstrap (already done in Task 99)
- Modifying worker or scout bootstrap templates
- Changing any runtime code

---

## Context

The master bootstrap has three provider-specific variants. Task 99 fixes the Claude variant. The Codex and Gemini variants need identical changes to the shared sections (worktree cleanup, task creation flow, monitoring).

### Current state

- `templates/master-bootstrap-codex-v1.txt` and `templates/master-bootstrap-gemini-v1.txt` have the same three issues as the Claude variant: reversed worktree cleanup, missing sync check, missing phase awareness.

### Desired state

- All three master bootstrap variants have identical content for: worktree cleanup ordering, task creation gate, and worker phase awareness.

### Start here

- `templates/master-bootstrap-v1.txt` — reference (already fixed by Task 99)
- `templates/master-bootstrap-codex-v1.txt` — apply changes
- `templates/master-bootstrap-gemini-v1.txt` — apply changes

**Affected files:**
- `templates/master-bootstrap-codex-v1.txt` — worktree, sync-check, phase awareness
- `templates/master-bootstrap-gemini-v1.txt` — worktree, sync-check, phase awareness

---

## Goals

1. Must fix worktree cleanup ordering in both Codex and Gemini master bootstraps.
2. Must add `orc backlog-sync-check` to task creation flow in both.
3. Must add worker phase awareness to monitoring section in both.
4. Must match the Claude variant's content for all three changes.

---

## Implementation

### Step 1 — Fix worktree cleanup in Codex bootstrap

**File:** `templates/master-bootstrap-codex-v1.txt`

Find the master worktree workflow section. Swap `git worktree remove` and `git branch -d` to match the Claude variant's ordering from Task 99.

### Step 2 — Fix worktree cleanup in Gemini bootstrap

**File:** `templates/master-bootstrap-gemini-v1.txt`

Same change as Step 1.

### Step 3 — Add backlog-sync-check to Codex bootstrap

**File:** `templates/master-bootstrap-codex-v1.txt`

In the "Planning new work" section, add `orc backlog-sync-check` after `create_task()`, matching the Claude variant.

### Step 4 — Add backlog-sync-check to Gemini bootstrap

**File:** `templates/master-bootstrap-gemini-v1.txt`

Same change as Step 3.

### Step 5 — Add worker phase awareness to Codex bootstrap

**File:** `templates/master-bootstrap-codex-v1.txt`

Add the 5-phase explanation and `query_events(event_type="phase_started")` guidance to the monitoring section, matching the Claude variant.

### Step 6 — Add worker phase awareness to Gemini bootstrap

**File:** `templates/master-bootstrap-gemini-v1.txt`

Same change as Step 5.

---

## Acceptance criteria

- [ ] Worktree cleanup ordering in Codex bootstrap: merge → branch delete → worktree remove.
- [ ] Worktree cleanup ordering in Gemini bootstrap: merge → branch delete → worktree remove.
- [ ] `orc backlog-sync-check` present in Codex bootstrap task creation flow.
- [ ] `orc backlog-sync-check` present in Gemini bootstrap task creation flow.
- [ ] Worker phases documented in Codex bootstrap monitoring section.
- [ ] Worker phases documented in Gemini bootstrap monitoring section.
- [ ] All three shared sections match across Claude, Codex, and Gemini variants.
- [ ] `npm test` passes.
- [ ] No changes to files outside the two provider-specific bootstrap templates.

---

## Tests

No new unit tests required. Validation via cross-variant diff comparison and existing tests passing.

---

## Verification

```bash
# Verify all three variants have matching cleanup ordering
for f in templates/master-bootstrap-v1.txt templates/master-bootstrap-codex-v1.txt templates/master-bootstrap-gemini-v1.txt; do
  echo "=== $f ==="
  grep -n 'branch -d\|worktree remove' "$f"
done

# Verify all three variants mention backlog-sync-check
grep -l 'backlog-sync-check' templates/master-bootstrap-*.txt
# Expected: 3 files

# Verify all three variants mention worker phases
grep -l 'explore.*implement.*review.*complete.*finalize' templates/master-bootstrap-*.txt
# Expected: 3 files

# Full suite
nvm use 24 && npm test
```
