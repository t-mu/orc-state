---
ref: global-project-state/230-serve-sandboxed-worker-reads-without-state-dir-write-access
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/229-route-worker-lifecycle-writes-through-an-authenticated-project-api
---

# Task 230 — Serve sandboxed worker reads without state-dir write access

Depends on Task 229.

## Scope

**In scope:**
- The read commands a project worker runs (`review-read`, `memory-wake-up`, `status`, `runs-active`, `run-info`) work in a sandbox that cannot write the project state directory, whether or not the coordinator is running.
- Verify, and configure if needed, that a sandboxed Codex worker (CLI and app-server runtime) can connect to `ORC_CONTROL_SOCKET`.
- Verify that Claude's Linux sandbox honours `network.allowUnixSockets` for that socket, for workers and for read-only scouts (their `report-for-duty`).

**Out of scope:**
- Legacy (unmigrated) installations.
- Worker lifecycle writes (done in Task 229).

---

## Context

Task 229 removed the project state directory from sandboxed workers' writable roots; lifecycle writes go through the coordinator's control API. Read commands still open `events.db` and `memory.db` directly. `getDb` and `initMemoryDb` run `journal_mode = WAL` and `CREATE TABLE IF NOT EXISTS`, and a WAL database cannot be opened without write access unless its `-wal`/`-shm` files already exist. They exist while the coordinator holds the database open, so reads fail only during a coordinator restart or when `memory.db` has no live WAL files.

Codex `workspace-write` restricts network access. Whether it allows a Unix-socket connection to the control socket was not verifiable when Task 229 shipped (its Linux sandbox needs user namespaces the build container lacked).

### Current state

Sandboxed project-worker reads depend on the coordinator keeping the databases open; Codex socket access is documented as unverified in `docs/configuration.md`.

### Desired state

Worker reads go through the control API (snapshot, events, messages) or open the databases read-only without DDL. Codex socket access is verified, with any required sandbox config added and tested.

### Start here

- `cli/review-read.ts`, `cli/memory-wake-up.ts`, `lib/eventLog.ts` (`getDb`), `lib/memoryStore.ts` (`initMemoryDb`).
- `lib/controlServer.ts` read routes; `adapters/pty.ts` `codexSandboxWritableRootArgs`, `adapters/codexAppServer.ts`.

**Affected files:** the files above, their tests, `e2e/clean-repo-project.e2e.test.ts`, `docs/configuration.md`.

---

## Acceptance criteria

- [ ] With the project state directory not writable and the coordinator stopped, `review-read` and `memory-wake-up` return their results (or a clear retryable error) instead of `attempt to write a readonly database`.
- [ ] The clean-repo e2e runs `review-read` under its stand-in sandbox.
- [ ] A sandboxed Codex worker's lifecycle command, and a sandboxed Claude worker's and scout's on Linux, reaches the control socket, or the docs state the supported configuration.
- [ ] The task-230 references in `docs/configuration.md` are removed.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test && npm run test:e2e
```
