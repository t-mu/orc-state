---
ref: global-project-state/229-route-worker-lifecycle-writes-through-an-authenticated-project-api
feature: global-project-state
review_level: full
priority: normal
status: done
depends_on:
  - global-project-state/228-prove-the-clean-repo-cli-and-tui-workflow
---

# Task 229 — Route worker lifecycle writes through an authenticated project API

Depends on Task 228.

## Scope

**In scope:**
- Worker lifecycle commands (`run-start`, `run-heartbeat`, `progress`, `run-work-complete`, `run-fail`, `run-finish`, `run-input-request`, `review-submit`, `memory-record`) in a registered project send their request to the coordinator's control socket (`ORC_CONTROL_SOCKET`), authenticated with the session credential (`ORC_SESSION_TOKEN`) and scoped to the caller's own run.
- The coordinator applies each request in its own process, so it is the only writer of the project's `runtime.db`, `events.db` and `claims.json`.
- Sandboxed workers lose write access to the project state directory; they keep their worktree, the target `.git` write subtrees and the control socket.

**Out of scope:**
- Legacy (unmigrated) installations, which keep direct writes until migrated.
- Desktop or Isolagent clients.

---

## Context

The plan-3 contract (`docs/global-project-contract.md`) says one coordinator owns a project's write transactions and that workers use an authorized project-scoped command API. Today worker lifecycle commands write the project state directory in the worker's own process. They are checked only against the claim's self-asserted `--agent-id`, and sandboxed workers are granted the whole state directory. The architecture review of plan 3 recorded this as a deviation.

### Current state

`lib/runCommands.ts` and `lib/claimManager.ts` run in the worker process and commit `claims.json`, `events.db` and `runtime.db` directly. `adapters/pty.ts` grants the project state directory as a sandbox writable root.

### Desired state

In project mode a worker can only affect its own run, through the coordinator's authenticated API. A worker with direct filesystem access cannot write project SQLite, because the sandbox no longer grants the state directory.

### Start here

- `lib/controlServer.ts`, `lib/controlClient.ts` — the existing control API and its session credentials.
- `lib/runCommands.ts`, `cli/progress.ts`, `cli/run-*.ts` — worker lifecycle entry points.
- `adapters/pty.ts` `sandboxExtraWritableRoots`, `adapters/codexAppServer.ts` — sandbox grants.

**Affected files:** the files above, plus their tests and `docs/configuration.md` (worker environment and sandbox sections).

---

## Acceptance criteria

- [ ] In project mode, each worker lifecycle command is applied by the coordinator through the control socket. A request whose session credential does not own the run is refused.
- [ ] Sandboxed project workers are not granted the project state directory, and an end-to-end run still completes (extend `e2e/clean-repo-project.e2e.test.ts`).
- [ ] The "Current deviation" note in `docs/global-project-contract.md` is removed.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test && npm run test:e2e
```
