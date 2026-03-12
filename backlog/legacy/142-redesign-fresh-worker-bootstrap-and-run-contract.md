---
ref: orch/task-142-redesign-fresh-worker-bootstrap-and-run-contract
epic: orch
status: todo
---

# Task 142 — Redesign Fresh Worker Bootstrap and Run Contract

Depends on Task 141.

## Scope

**In scope:**
- `lib/sessionBootstrap.mjs` — generate a fresh-worker bootstrap path that matches per-task spawning
- `templates/worker-bootstrap-v2.txt` — replace persistent-session assumptions with task-scoped worker instructions
- `templates/task-envelope-v2.txt` — include stronger per-task bootstrap context for fresh workers
- task-envelope rendering and related helper code used to build task handoff payloads
- a docs/task-spec reader helper under `lib/` so richer task-spec sections can be loaded from markdown at dispatch time without requiring a backlog schema expansion in this task

**Out of scope:**
- Starting worker sessions or allocating worker slots
- Rewriting master bootstrap templates
- Expanding `backlog.json` schema to persist full task-spec sections
- Coordinator dispatch or cleanup logic
- Status output and operator-facing CLI changes

---

## Context

Fresh workers will only be viable if the task handoff contains enough durable context to replace session memory. The current worker bootstrap still assumes a long-lived headless session waiting around for multiple assignments, while `TASK_START` includes only a limited task summary. That is acceptable for persistent workers, but it weakens a per-task-worker model because every fresh session must reconstruct context from scratch.

This migration needs a stronger bootstrap contract before the coordinator starts spawning workers per task. The handoff should carry the durable context the agent needs immediately: the task’s current state, desired state, first files to inspect, acceptance criteria, verification commands, and run lifecycle rules.

### Current state

`worker-bootstrap-v2.txt` still describes an idle session that stays alive while registered. `task-envelope-v2.txt` includes title, description, acceptance criteria, and a JSON contract, but the richer task-spec sections live only in markdown under `docs/backlog`; they are not stored in backlog state today.

`buildSessionBootstrap()` only selects a generic worker template. It does not distinguish between persistent workers and fresh task-scoped workers.

### Desired state

Fresh workers should receive a bootstrap and task envelope that are explicitly written for task-scoped sessions. The instructions should assume the session exists for one task, receives a single task handoff, executes the task in a worktree, reports lifecycle events, and then exits.

The task handoff should include the durable task-spec context required for a fresh worker to succeed without relying on hidden prior conversation state. In this migration step, that richer context should be sourced from the markdown task spec directly when the coordinator builds the handoff.

### Start here

- `templates/worker-bootstrap-v2.txt` — current worker session contract
- `templates/task-envelope-v2.txt` — current task handoff payload
- `lib/sessionBootstrap.mjs` — current template selection logic
- `coordinator.mjs` — current `buildTaskEnvelope()` path only reads backlog state

<!-- Optional:
### Dependency context

Task 141 introduces coordinator-managed worker slots and config. This task updates the worker bootstrap contract that those slots will use once the coordinator starts spawning a fresh session for each claimed task, and it explicitly pulls richer task context from markdown task specs instead of widening backlog state first.
-->

**Affected files:**
- `lib/sessionBootstrap.mjs` — bootstrap selection and rendering
- `templates/worker-bootstrap-v2.txt` — worker instructions
- `templates/task-envelope-v2.txt` — task handoff content
- new task-spec reader helper under `lib/` — load current-state/desired-state/start-here/verification from markdown
- `lib/sessionBootstrap.test.mjs` — bootstrap contract coverage

---

## Goals

1. Must rewrite the worker bootstrap around task-scoped worker sessions rather than persistent registered workers.
2. Must ensure the task envelope carries durable task context suitable for a fresh worker start, sourcing richer task-spec sections from markdown task specs at dispatch time.
3. Must keep the run lifecycle commands explicit and deterministic for task-scoped workers.
4. Must preserve the master bootstrap path unchanged.
5. Must produce a handoff contract that later coordinator-spawn tasks can consume without further prompt redesign.

---

## Implementation

### Step 1 — Introduce a task-scoped worker bootstrap variant

**Files:**
- `lib/sessionBootstrap.mjs`
- `templates/worker-bootstrap-v2.txt`

Refactor the worker bootstrap so its language matches a task-scoped worker lifecycle. Remove or rewrite assumptions that the worker remains alive indefinitely waiting for multiple unrelated tasks.

Preserve the existing master bootstrap path. Only the worker side should change here.

### Step 2 — Strengthen the task envelope payload

**Files:**
- `templates/task-envelope-v2.txt`
- new task-spec reader helper under `lib/`

Extend the payload so a fresh worker gets the task-spec bootstrap information immediately. Load `Current state`, `Desired state`, `Start here`, and targeted verification details from the markdown task spec when building the handoff. The worker should not need to infer these fields from a long free-form description.

### Step 3 — Update helper code and tests

**Files:**
- `lib/sessionBootstrap.mjs`
- `lib/sessionBootstrap.test.mjs`
- task-envelope rendering tests
- tests for the markdown task-spec reader helper

Add or update tests that assert the fresh-worker bootstrap and task envelope contain the intended contract elements.

---

## Acceptance criteria

- [ ] Worker bootstrap text assumes a task-scoped worker session rather than a persistent registered worker.
- [ ] The task envelope includes durable bootstrap context suitable for a fresh worker start, including richer sections loaded from the markdown task spec.
- [ ] The run lifecycle commands remain explicit and in the correct order for task-scoped execution.
- [ ] Master bootstrap behavior remains unchanged.
- [ ] The new bootstrap contract is covered by focused tests.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `lib/sessionBootstrap.test.mjs` — assert the worker bootstrap reflects task-scoped session semantics
- a task-envelope rendering test near the template/render helpers — assert current-state/desired-state/start-here/verification context is present in the worker handoff
- tests for the markdown task-spec reader helper — assert the richer sections are parsed correctly from task docs

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs lib/sessionBootstrap.test.mjs lib/templateRender.test.mjs
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

**Risk:** If the bootstrap and task envelope diverge, fresh workers may start with contradictory instructions and fail to report run lifecycle correctly.
**Rollback:** Restore the prior worker bootstrap and envelope templates, then rerun the targeted bootstrap tests.
