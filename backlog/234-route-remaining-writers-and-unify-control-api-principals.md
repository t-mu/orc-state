---
ref: global-project-state/234-route-remaining-writers-and-unify-control-api-principals
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/233-rename-session-id-and-credential-variables
---

# Task 234 — Route remaining writers and unify control API principals

Depends on Task 233.

## Scope

**In scope:**
- In a registered project, send task authoring (`orc project task create|edit|import`, MCP `create_task`/`update_task`) and the recovery commands `orc run-expire` and `orc task-mark-done` to the coordinator, with the same "apply directly only when no coordinator holds the project" fallback as `submitOperatorMutation` (`lib/operatorDispatch.ts`). `/v1/tasks` POST accepts the operator as well as the master.
- One principal resolver for every control route: `{ kind: worker(run) | master | operator, agentId, runId, live }`, replacing `sessionAuthenticator`, `taskAuthor`, `readerScope`/`projectReader`, `authorizeOperator`'s session branch and `authorizeLifecycle`'s lookup, with one liveness rule.
- Typed domain errors (`NotFoundError`, `ConflictError`, `InputError`) thrown by `lib/operatorMutations.ts`, `lib/workerLifecycle.ts` and `lib/projectTasks.ts`, mapped to HTTP status by type instead of by message regex (`OPERATOR_REFUSALS`, `DOMAIN_ERRORS`, the `/v1/lifecycle` catch-all `409`). An unexpected failure on `/v1/lifecycle` is `500 internal`, not `409`.
- Decide the read-only SQLite fallback (`lib/sqliteReadOnly.ts`): it serves a sandboxed worker only while WAL files remain (coordinator crashed, or version skew). Keep it documented as exactly that, or drop it for a plain "coordinator not running" error.

**Out of scope:**
- Worker registration/removal and scout launch writers.
- New routes for desktop or Isolagent clients.

---

## Context

The full review after Task 233 found the remaining direct writers (listed in `docs/global-project-contract.md`) and three authorization models in `lib/controlServer.ts`, `lib/operatorMutations.ts` and `lib/workerLifecycle.ts`. Their behaviour is correct and documented, but a desktop/TUI client or an Isolagent transport needs one principal model to bind credentials to, and HTTP status codes currently depend on error wording.

### Current state

Task authoring, `run-expire` and `task-mark-done` write project state in the caller's process. `ControlClient.createTask`/`reviseTask` have no production caller. Status codes come from regexes over error text.

### Desired state

Every project write a client makes goes through the coordinator when one runs; every route resolves its caller through one function; error types, not text, select status codes.

### Start here

- `lib/controlServer.ts` (`sessionAuthenticator`, `taskAuthor`, `readerScope`, `projectReader`, `operatorError`, `DOMAIN_ERRORS`), `lib/operatorMutations.ts` (`authorizeOperator`), `lib/workerLifecycle.ts` (`authorizeLifecycle`), `lib/operatorDispatch.ts`.
- `mcp/handlers.ts` `handleCreateTask`/`handleUpdateTask`, `cli/project.ts`, `cli/run-expire.ts`, `cli/task-mark-done.ts`, `lib/taskCompletion.ts`.

**Affected files:** the files above, their tests, `docs/contracts.md`, `docs/global-project-contract.md`, `docs/cli.md`.

---

## Acceptance criteria

- [ ] With a coordinator running, `orc project task create|edit|import`, MCP `create_task`/`update_task`, `orc run-expire` and `orc task-mark-done` in a project are applied by the coordinator; with none, they write directly and say so; while a live coordinator is not answering, they refuse with a retryable error.
- [ ] Every control route resolves its caller through one principal function, with tests for worker, master, operator and bearer-only callers.
- [ ] Status codes are chosen by error type; an internal failure on `/v1/lifecycle` returns `500`.
- [ ] The read-only SQLite fallback is either documented as crash/version-skew only or removed.
- [ ] `docs/global-project-contract.md` lists only the writers that remain.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test && npm run test:e2e
```
