---
ref: global-project-state/232-route-master-and-operator-mutations-through-the-coordinator
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/229-route-worker-lifecycle-writes-through-an-authenticated-project-api
---

# Task 232 — Route master and operator mutations through the coordinator

Depends on Task 229.

## Scope

**In scope:**
- In a registered project, the master's MCP mutations (`cancel_task`, `reset_task`, `delegate_task`, `respond_input`) and operator CLI mutations (`orc task-reset`, `task-unblock`, `delegate`, `run-input-respond`) are applied by the coordinator through the control API.
- When the coordinator is not running, operator recovery commands keep a documented direct path (they are not sandboxed), and say so.

**Out of scope:**
- Task authoring (`/v1/tasks` already goes through the API or the project task store transactions).
- Legacy installations.

---

## Context

The plan-3 contract says one coordinator owns a project's write transactions and clients use an authorized project-scoped API. Task 229 made that true for worker lifecycle commands. Master and operator mutations still take the state lock and write `claims.json`, `events.db` and `runtime.db` in their own process.

### Current state

`mcp/handlers.ts` (`cancel_task`, `reset_task`) and `cli/task-reset.ts`, `cli/task-unblock.ts` mutate state directly.

### Desired state

While a project coordinator runs, it is the only process that writes the project's runtime state.

### Start here

- `mcp/handlers.ts`, `cli/task-reset.ts`, `cli/task-unblock.ts`, `cli/run-input-respond.ts`.
- `lib/controlServer.ts`, `lib/workerLifecycle.ts` (the worker-side pattern from Task 229).

**Affected files:** the files above, their tests, `docs/contracts.md`, `docs/configuration.md`, `docs/global-project-contract.md`.

---

## Acceptance criteria

- [ ] With a project coordinator running, each listed master/operator mutation is applied by the coordinator and authorized as master or operator.
- [ ] With no coordinator running, operator recovery still works and the docs say how.
- [ ] The task-232 deviation notes in the docs are removed.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test && npm run test:e2e
```
