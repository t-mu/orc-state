---
ref: global-project-state/231-authenticate-sessions-with-per-session-secrets
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/230-serve-sandboxed-worker-reads-without-state-dir-write-access
---

# Task 231 — Authenticate sessions with per-session secrets

Depends on Task 230.

## Scope

**In scope:**
- Each launched session (worker, scout, master) receives a secret credential that is never written to the state directory, PTY logs, the bootstrap prompt or event payloads; the state stores only its hash.
- The control API (`/v1/lifecycle`, `/v1/messages`, `/v1/commands`, `/v1/tasks`) authenticates callers by that secret instead of the readable session id.
- `report-for-duty` proves the session without echoing a secret into `events.db`.

**Out of scope:**
- Process isolation between same-user processes beyond the provider sandbox.
- Legacy installations.

---

## Context

Task 229 routed project workers' lifecycle writes through the coordinator and checks the caller's session against the named run. The credential is the session id, which is stored in `agents.json`, the `sessions` table, the `reported_for_duty` payload and the bootstrap text in PTY logs. Workers can read the state directory, so a worker that looks up a peer's id can act as that peer. The architecture review recorded this as a deviation from "an authorized project-scoped command API".

### Current state

`sessionAuthenticator` and `authorizeLifecycle` look up the presented value as `sessions.session_id`.

### Desired state

Presenting a value read from the state directory authenticates nobody. Once Task 230 serves worker reads through the API, sandboxed workers can also be denied read access to the state directory.

### Constraints from Task 230

- The worker read routes (`GET /v1/runs/<run_id>/reviews`, `GET /v1/memory/wake-up`) accept the bearer token alone. Scope them by the session credential (a worker reads only its own run's reviews) together with the other routes.
- `worker_pool.sandbox_network: open` lets a sandboxed Linux Claude worker reach every Unix socket (including orc's private tmux server) and a Codex worker the network. A secret is only as strong as that boundary: document that per-session secrets assume the default `restricted` network, or a host where those sockets are unreachable.

### Start here

- `lib/workerRuntime.ts` (`launchWorkerSession`, `normalizeWorkerEnv`), `cli/start-session.ts`, `lib/sessionBootstrap.ts`.
- `lib/controlServer.ts` (`sessionAuthenticator`), `lib/workerLifecycle.ts` (`authorizeLifecycle`), `lib/runStore.ts` (`recordProviderSession`).

**Affected files:** the files above, their tests, `e2e/clean-repo-project.e2e.test.ts`, `docs/contracts.md`, `docs/configuration.md`, `docs/global-project-contract.md`.

---

## Acceptance criteria

- [ ] A worker that presents another session's id (read from the state directory) is refused on every control API route.
- [ ] No secret credential appears in the state directory, PTY logs or event payloads.
- [ ] The e2e shows a peer worker's recorded session id cannot act on its run.
- [ ] The task-231 deviation notes in the docs are removed.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test && npm run test:e2e
```
