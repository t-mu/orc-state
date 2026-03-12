---
ref: orch/task-152-surface-finalization-status-and-preserved-blocked-work
epic: orch
status: done
---

# Task 152 — Surface Finalization Status and Preserved Blocked Work

Depends on Task 151.

## Scope

**In scope:**
- `lib/statusView.mjs` and related status CLIs — show finalization-phase runs, retry counts, and blocked preserved work
- `orchestrator/README.md` and operator docs — explain the new finalize ownership split and blocked-work preservation model
- any trusted CLI/control surface needed to inspect merge-ready or blocked runs without inventing a second workflow engine
- optional conservative cleanup guidance for successfully merged worktrees if needed for operator clarity

**Out of scope:**
- Provider launch implementation
- New reassignment workflow for blocked runs
- Background garbage collection of blocked worktrees
- Further changes to the merge retry algorithm

---

## Context

After the coordinator starts owning final merge and retry behavior, operators need visibility into finalization state. A blocked finalization run is not failed work; it is preserved work waiting for intervention. If status output does not surface that clearly, the system will look flaky or silently leak preserved branches/worktrees.

This task is the operational closeout: make the finalization model visible, understandable, and safe to monitor.

### Current state

Status output centers on agents, tasks, and active claims, but it does not distinguish work-complete waiting-for-merge runs from blocked preserved runs.

The docs still center older assumptions about agent-owned merge/cleanup rather than coordinator-owned finalization.

### Desired state

Status should show:
- runs awaiting finalize
- finalize retry counts
- blocked finalization with preserved worktree/branch metadata
- successful merged cleanup outcomes

Docs should explain that blocked finalization preserves work and that merge/cleanup now belong to the coordinator, while the agent still owns rebase/conflict resolution when asked.

### Start here

- `lib/statusView.mjs` — current status aggregation and formatting
- `cli/status.mjs` and `cli/watch.mjs` — current terminal status surfaces
- `orchestrator/README.md` — current operator workflow documentation

<!-- Optional:
### Dependency context

Task 151 implements coordinator-owned finalization with a two-retry blocked fallback. This task exposes that new lifecycle to operators and documents how preserved blocked work should be understood.
-->

**Affected files:**
- `lib/statusView.mjs` — finalization-aware status aggregation
- `cli/status.mjs` and `cli/watch.mjs` — status rendering
- `orchestrator/README.md` — finalization workflow documentation
- any small trusted CLI/help surface added for inspection of blocked/awaiting-finalize runs

---

## Goals

1. Must make finalization-phase state visible in status output.
2. Must clearly distinguish blocked preserved work from implementation failure.
3. Must document the split of responsibilities: agent rebases, coordinator merges/cleans up.
4. Must avoid introducing a second workflow engine outside the coordinator; any added CLI should be a control surface over coordinator-owned state.
5. Must leave operators with a clear view of which worktrees are preserved because finalization blocked.

---

## Implementation

### Step 1 — Extend status aggregation and formatting

**Files:**
- `lib/statusView.mjs`
- `cli/status.mjs`
- `cli/watch.mjs`

Add finalization-aware summaries and detail sections. Include retry count and preserved worktree/branch metadata for blocked runs where practical.

### Step 2 — Document the new finalization workflow

**File:** `orchestrator/README.md`

Explain:
- the coordinator allocates worktrees and owns merge/cleanup
- agents remain alive after work completion and may be asked to rebase again
- blocked finalization preserves work rather than rejecting it

### Step 3 — Add focused operator-facing tests

**Files:**
- `lib/statusView.test.mjs`
- `cli/status.test.mjs`
- `cli/watch.test.mjs`

Cover the new finalization states and blocked preserved-work rendering.

---

## Acceptance criteria

- [ ] Status output shows finalization-phase runs and retry counts.
- [ ] Blocked finalization is clearly represented as preserved work, not generic task failure.
- [ ] Docs explain the coordinator-owned finalization model and the agent’s rebase role.
- [ ] Any added CLI/help surface acts only as a coordinator control/inspection entrypoint, not a second workflow engine.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `lib/statusView.test.mjs` — assert finalization-phase and blocked preserved-work output
- `cli/status.test.mjs` — assert CLI output exposes finalize retry/blocked information
- `cli/watch.test.mjs` — assert watch mode renders the new state cleanly

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs lib/statusView.test.mjs cli/status.test.mjs cli/watch.test.mjs
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
node cli/orc.mjs doctor
node cli/orc.mjs status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** If status/docs lag the runtime change, blocked preserved runs can look like silent failures or unexplained leaked worktrees.
**Rollback:** Restore the prior status wording, then reintroduce the new finalization sections with explicit preserved-work labels once the runtime model is stable.
