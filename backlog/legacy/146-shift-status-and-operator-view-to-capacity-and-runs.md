---
ref: orch/task-146-shift-status-and-operator-view-to-capacity-and-runs
epic: orch
status: todo
---

# Task 146 — Shift Status and Operator View to Capacity and Runs

Depends on Task 144.

## Scope

**In scope:**
- `lib/statusView.mjs` — report worker capacity, active runs, and startup failures instead of persistent-worker liveness assumptions
- `cli/status.mjs`, `cli/watch.mjs`, and related status surfaces — present the new model clearly
- run-activity helpers under `lib/` — expose the right data for active runs and slot capacity
- docs/help text that explain how to read the new status view

**Out of scope:**
- Core dispatch behavior
- Startup wizard changes
- Worker bootstrap/task envelope content
- Rewriting event schemas beyond what the status view directly requires

---

## Context

Status output still reflects the persistent-worker model. It reports workers as registered agents with heartbeat-oriented liveness, which made sense when headless worker sessions stayed alive between tasks. In a per-task-worker model, the operator mostly cares about available capacity, active runs, startup failures, and tasks waiting for worker slots.

Without a status redesign, the new runtime model will remain confusing even if the coordinator behaves correctly. The UI should stop suggesting that idle workers are supposed to exist as always-on background sessions.

### Current state

`statusView.mjs` counts agents by `running`, `idle`, and `offline`, then prints per-agent heartbeat information. That emphasizes persistent worker liveness over queued work, slot capacity, and active run health.

### Desired state

Status should make the new execution model obvious: one master session, N worker slots of capacity, active runs currently consuming slots, queued tasks waiting for capacity, and recent startup or lifecycle failures that need attention.

Idle worker slots should read as available capacity, not as suspicious agents with missing heartbeats.

### Start here

- `lib/statusView.mjs` — current status aggregation and formatting
- `cli/status.mjs` — current status CLI entry point
- `cli/watch.mjs` — current live status refresh behavior

<!-- Optional:
### Dependency context

Task 144 changes runtime execution to task-scoped workers. This task updates the operator-facing status model so it matches that new runtime instead of presenting stale persistent-worker concepts.
-->

**Affected files:**
- `lib/statusView.mjs` — aggregate/format the new status model
- `cli/status.mjs` — status command output
- `cli/watch.mjs` — watch-mode rendering
- run-activity/status helper modules under `lib/`
- `orchestrator/README.md` — reading the new status output

---

## Goals

1. Must make status output describe worker capacity and active runs rather than persistent worker liveness.
2. Must clearly distinguish the foreground master from background worker capacity.
3. Must surface startup failures, stalled runs, and queued work in a way that matches the task-scoped worker model.
4. Must reduce misleading “idle worker with no heartbeat” diagnostics.
5. Must keep the status output useful for debugging coordinator-managed worker failures.

---

## Implementation

### Step 1 — Redefine the status aggregate model

**Files:**
- `lib/statusView.mjs`
- supporting helpers under `lib/`

Change the aggregate model so it can report total worker capacity, used slots, available slots, active runs, and recent launch/lifecycle failures. Preserve enough detail for debugging without centering the view on persistent agent heartbeats.

### Step 2 — Update CLI rendering

**Files:**
- `cli/status.mjs`
- `cli/watch.mjs`

Render the new model in terminal-friendly output. The master should be clearly identified as the foreground controller, while worker information should read as capacity and run state.

### Step 3 — Align docs/help text

**File:** `orchestrator/README.md`

Document how to read the new status output and what kinds of failure signals matter in the per-task-worker model.

---

## Acceptance criteria

- [ ] Status output reports worker capacity and active runs rather than centering on persistent worker heartbeat state.
- [ ] The master is clearly separated from worker capacity in status output.
- [ ] Startup failures, stalled runs, and queued work are visible in the status view.
- [ ] Misleading idle/no-heartbeat diagnostics are removed or reduced materially.
- [ ] The new output is covered by focused status-view tests.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `lib/statusView.test.mjs` — assert the aggregate model and formatted output reflect capacity/runs
- `cli/status.test.mjs` — assert CLI output distinguishes master vs worker capacity
- `cli/watch.test.mjs` — assert watch mode renders the new status summary cleanly

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

**Risk:** If status changes hide too much detail, operators may lose the ability to diagnose worker startup and run failures during the migration.
**Rollback:** Restore the old status format, then reintroduce the new capacity summaries with explicit failure sections instead of replacing all detail at once.
