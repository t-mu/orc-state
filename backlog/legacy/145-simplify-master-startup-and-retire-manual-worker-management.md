---
ref: orch/task-145-simplify-master-startup-and-retire-manual-worker-management
epic: orch
status: todo
---

# Task 145 — Simplify Master Startup and Retire Manual Worker Management

Depends on Task 144.

## Scope

**In scope:**
- `cli/start-session.mjs` — reduce startup to coordinator + master preparation only
- `lib/prompts.mjs` — remove or demote worker-pool creation prompts from the default flow
- `cli/register-worker.mjs`, `cli/start-worker-session.mjs`, and `cli/control-worker.mjs` — reposition manual worker commands as advanced/debug-only paths
- `orchestrator/README.md` — update the operator workflow to a master-only startup model

**Out of scope:**
- Core dispatch or worker-launch logic
- Status view redesign
- Removing every worker CLI from the codebase
- Changes to task bootstrap templates

---

## Context

After dispatch is moved to task-scoped workers, the operator should no longer be asked to create or manage a worker pool manually. The user-facing workflow should reflect the real system design: one foreground master session, with headless workers launched and cleaned up by the coordinator as needed.

This task is about collapsing the exposed operator model to match the new runtime model. Worker commands can still exist for debugging, but they should no longer appear to be the normal way to use the orchestrator.

### Current state

`orc-start-session` still includes worker-pool choices and worker-creation loops. Separate CLIs also exist for worker registration, worker session startup, and worker control, which makes the overall product feel like the user is expected to manage headless workers directly.

### Desired state

The default startup path should be unambiguous: ensure the coordinator is running, ensure the master session is configured, and launch the master in the current terminal. Worker management should move behind the coordinator, while manual worker CLIs become debug-oriented escape hatches with clear wording.

### Start here

- `cli/start-session.mjs` — current startup wizard
- `lib/prompts.mjs` — worker-pool prompt flow
- `orchestrator/README.md` — current operator instructions

<!-- Optional:
### Dependency context

Task 144 completes the runtime cutover to task-scoped workers. This task updates the operator-facing UX so the user no longer has to think about worker registration as part of normal orchestrator usage.
-->

**Affected files:**
- `cli/start-session.mjs` — foreground startup flow
- `lib/prompts.mjs` — interactive prompt copy and sequencing
- `cli/register-worker.mjs` — debug-only worker registration wording
- `cli/start-worker-session.mjs` — debug-only session-start wording
- `cli/control-worker.mjs` — debug/inspection positioning
- `orchestrator/README.md` — operator documentation

---

## Goals

1. Must make `orc-start-session` clearly master-first and master-only in normal usage.
2. Must remove worker-pool setup from the default startup flow.
3. Must keep manual worker commands available only as advanced/debug tooling, with clear wording.
4. Must update docs so users are not misled into managing workers directly.
5. Must preserve clarity around master vs worker provider selection.

---

## Implementation

### Step 1 — Simplify the startup wizard

**Files:**
- `cli/start-session.mjs`
- `lib/prompts.mjs`

Remove worker-pool setup from the normal wizard. Keep the master section visually dominant and explicit, and make it clear that headless workers are coordinator-managed background capacity.

### Step 2 — Demote manual worker commands to debug-only tooling

**Files:**
- `cli/register-worker.mjs`
- `cli/start-worker-session.mjs`
- `cli/control-worker.mjs`

Update help text and operator messages so these commands are positioned as debug/override tools rather than the primary workflow.

### Step 3 — Update operator documentation

**File:** `orchestrator/README.md`

Rewrite the normal startup flow so it matches the new runtime contract: one foreground master, coordinator-managed headless workers, no manual worker registration required for standard operation.

---

## Acceptance criteria

- [ ] `orc-start-session` no longer asks the user to create a worker pool in the default path.
- [ ] Master setup remains visually and semantically distinct from any worker-related debug actions.
- [ ] Manual worker CLIs are clearly labeled as advanced/debug tooling rather than the normal workflow.
- [ ] README instructions describe a master-only startup flow with coordinator-managed workers.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `cli/start-session.test.mjs` — assert the startup flow only prepares coordinator + master in the normal path
- `lib/prompts.test.mjs` — assert worker-pool prompts are removed or relegated appropriately
- `cli/register-worker.test.mjs` and `cli/start-worker-session.test.mjs` — assert debug-oriented wording/help text

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs cli/start-session.test.mjs lib/prompts.test.mjs cli/register-worker.test.mjs cli/start-worker-session.test.mjs
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

**Risk:** If startup UX changes land before the runtime cutover is stable, users can lose the fallback path they currently rely on.
**Rollback:** Restore the prior startup prompts and CLI wording, keeping the runtime migration behind the scenes until the dispatch path is stable.
