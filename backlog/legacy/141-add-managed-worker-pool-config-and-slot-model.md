---
ref: orch/task-141-add-managed-worker-pool-config-and-slot-model
epic: orch
status: todo
---

# Task 141 — Add Managed Worker Pool Config and Slot Model

Independent.

## Scope

**In scope:**
- `coordinator.mjs` — stop assuming a manually registered persistent worker set and load worker capacity from config
- `lib/agentRegistry.mjs` — represent coordinator-managed worker slots separately from the foreground master
- `lib/providers.mjs` and related config helpers — add a framework-level source for worker provider defaults and `max_workers`

**Out of scope:**
- Starting or stopping per-task worker sessions
- Dispatching real work through spawned ephemeral workers
- Removing worker-pool setup from the default `orc-start-session` flow before the runtime cutover lands
- Rewriting worker bootstrap or task envelope content
- Status output and operator docs beyond what is required to introduce the new config surface

---

## Context

The current orchestrator still models workers as manually registered long-lived agents. `orc-start-session` asks the user to create or reuse a worker pool, and the coordinator then treats those agents as durable headless sessions. That leaks implementation details into the operator model and makes a future per-task worker design harder to stage cleanly.

The migration needs a first-class concept of coordinator-managed worker capacity. Before the coordinator can launch fresh workers per task, it needs a deterministic slot model and config source that defines how many workers may exist and which provider settings to use when the coordinator spawns them.

### Current state

Worker lifecycle begins with manual registration. The coordinator reads `agents.json` as if worker entries are durable identities created ahead of time by the user, while the startup wizard asks the user to decide how many workers should exist.

There is no configuration object describing worker pool capacity. The only durable worker inventory is whatever has been manually written into agent state.

### Desired state

The orchestrator should have an explicit worker-pool config with at least `max_workers` and default worker provider settings. The coordinator should be able to derive or maintain worker slots from that config without asking the user to register headless workers manually.

The master remains a single foreground session, while worker slots become coordinator-managed execution capacity that later tasks can attach ephemeral sessions to. The operator-facing startup cutover can stay for a later task; this task is only the runtime/config foundation.

### Start here

- `coordinator.mjs` — current assumptions about agent inventory and worker readiness
- `lib/agentRegistry.mjs` — current agent schema and runtime updates
- `lib/dispatchPlanner.mjs` — current dispatch assumes dispatchable workers already exist in agent state

<!-- Optional:
### Dependency context

This is the migration foundation. Later tasks will use the slot model introduced here to attach task-scoped worker sessions, route dispatch through those slots, and simplify the master-only startup flow.
-->

**Affected files:**
- `coordinator.mjs` — current coordinator tick logic and worker readiness assumptions
- `lib/agentRegistry.mjs` — worker/master record shape and runtime updates
- `lib/dispatchPlanner.mjs` — dispatch selection assumptions over worker records
- `lib/providers.mjs` — provider metadata and a likely home for worker defaults
- `orchestrator/README.md` — document the new pool config surface once implemented, without changing the default startup UX yet

---

## Goals

1. Must introduce a framework-level configuration source for worker capacity, including `max_workers`.
2. Must define a stable worker-slot model that the coordinator can manage without interactive worker registration.
3. Must keep the foreground master as a distinct role from the managed worker pool.
4. Must preserve compatibility for existing state files during the migration stage instead of requiring a flag day.
5. Must make later per-task worker tasks possible without further redesign of the startup contract.

---

## Implementation

### Step 1 — Add worker-pool config loading

**Files:**
- `lib/providers.mjs`
- `lib/paths.mjs`
- any new config helper under `lib/`

Add a config-loading path for worker-pool settings. It must produce deterministic defaults when no explicit config file or env override is present, including a sane `max_workers` default and the default provider for headless workers.

Preserve the existing provider registry shape where possible; this task is about introducing configuration, not rewriting adapters.

### Step 2 — Define coordinator-managed worker slots

**Files:**
- `lib/agentRegistry.mjs`
- `coordinator.mjs`

Add a worker-slot concept that can be materialized from config. Stable slot IDs such as `orc-1`, `orc-2`, and so on are acceptable for this migration. The coordinator must be able to reason about these slots without relying on prior manual registration.

Keep the master model intact. Do not collapse master and worker state into one generic session type.

### Step 3 — Document the new config contract

**File:** `orchestrator/README.md`

Document the new configuration and slot model in concise operator language. Be explicit that worker count now comes from config and is managed by the coordinator internally, while the user-facing startup flow remains unchanged until the later UX cutover task.

---

## Acceptance criteria

- [ ] There is a durable framework-level configuration source for worker pool settings, including `max_workers`.
- [ ] The coordinator can derive or maintain stable worker slots from configuration without interactive worker registration.
- [ ] The master remains a separate foreground role and is not counted as worker capacity.
- [ ] The runtime has a stable slot/capacity model ready for later per-task session spawning without requiring the startup UX cutover in the same change.
- [ ] Existing state handling remains compatible enough to continue the staged migration.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `lib/agentRegistry.test.mjs` — assert worker slots can be synthesized or managed from config
- `orchestrator/coordinator.test.mjs` — assert the coordinator can see configured worker capacity without manual worker registration
- `lib/dispatchPlanner.test.mjs` — assert dispatch-planning logic can reason about slot-derived capacity

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs lib/agentRegistry.test.mjs lib/dispatchPlanner.test.mjs orchestrator/coordinator.test.mjs
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

**Risk:** Introducing worker-pool config without a clean compatibility layer can break existing startup behavior or orphan current worker records.
**Rollback:** Revert the config/slot changes, restore the previous worker-registration flow, and rerun `node cli/orc.mjs doctor`.
