# vNext architecture and migration map

**Historical migration map:** The public orc-state repository now owns the base
coordination framework only. Isolagent integration and the desktop client are
planned for a separate private repository that depends on a pinned orc-state
release. Backlog tasks 208 and 210–217 are cancelled here; references below
describe the earlier proposal, not current implementation work.

Status: proposed, validated against `main` at `f63b06c` on 2026-10-17. The
[implementation brief](../ORC_STATE_VNEXT_IMPLEMENTATION_BRIEF.md) is product
intent; this document records the repository-specific path. The brief is currently
an untracked file in the main checkout, so this link is contextual rather than a
committed dependency.

Baseline verification in the dedicated worktree: `npm test` passed on Node
24.21.0 (135 test files passed, 1,765 tests passed, 7 skipped). No baseline
failures were observed.

## Current state versus target

| Requirement | Current implementation | Disposition and target |
|---|---|---|
| Markdown task and plan authority | `lib/backlogSync.ts`, `lib/taskSpecReader.ts`, `lib/planDocs.ts`; `backlog/*.md` syncs to `backlog.json`. (The spec generator and the `plan_write`/`spec_publish` verbs have since been removed.) | **Adapt first.** Sync and validate dependency frontmatter before publishing dependent tasks. Then add a rebuildable hash/validation index and pin a snapshot at claim time. Preserve attached and sibling layouts. |
| Dependency routing and Git lifecycle | `lib/taskRouting.ts`, `lib/dispatchPlanner.ts`, `lib/claimManager.ts`, `lib/runWorktree.ts`, coordinator finalization. | **Reuse/adapt.** Keep dispatch, review, rebase/merge semantics. Move operational run truth to SQLite incrementally; retain compatibility readers until cutover. |
| Event history | `lib/eventLog.ts` provides SQLite WAL, FTS, `readEventsSince`, and filtered queries. `appendSequencedEvent` separately reads `MAX(seq)+1`. | **Adapt first.** Allocate sequence inside the insert transaction; keep payload `seq` equal to row `seq`, and test concurrent processes. |
| Operational state | `backlog.json`, `agents.json`, `claims.json`, `run-worktrees.json`, and `event-checkpoint.json` use locks/atomic file replacement. A claim writes multiple files and then an event. | **Build/adapt.** Versioned SQLite operational tables and transition functions append events in the same transaction. One authoritative writer per field during cutover; JSON compatibility is read-only or derived after its cutover. |
| Event consumption | `coordinator.ts` reads the full event history each tick, prunes a JSON checkpoint, and rebuilds activity maps. | **Adapt.** Durable `consumer_offsets`, bounded `seq > cursor` reads, replay on restart, and transactionally applied projections. Preserve searchable history. |
| Input and review messages | `lib/runCommands.ts`, CLI/MCP input request and response, review events, and PTY sends. | **Build.** Durable commands/messages with run scope, idempotency, semantic ACK, timeout, `outcome_unknown`, and bounded retries. PTY write means only `sent`. |
| Provider integration | `adapters/interface.ts` and `adapters/pty.ts` expose `start/send/attach/probe/stop`; Codex, Claude, Gemini are CLI modes. | **Adapt/build.** Keep PTY as fallback; add capability-based structured runtimes only after subscription and protocol smoke tests. Fake runtimes verify deterministic behavior. |
| Worker workspace | `lib/workerRuntime.ts` passes `working_directory`; `adapters/pty.ts` currently prefers `ORC_REPO_ROOT` as process cwd. | **Adapt.** Spawn in the assigned worktree and repair provider sandbox/Git metadata paths; keep `ORC_HOME` for orchestration state resolution. |
| Process recovery | `coordinator.ts` probes a PID file and marks stale agents; PTY handles live in coordinator memory. | **Build.** Stable provider session identity, supervisor ownership or explicit resume, process reconciliation, and recoverable/unknown status. Do not kill a healthy worker solely on daemon restart. |
| Terminal access | `cli/attach.ts` and `cli/control-worker.ts` print a log tail; `node-pty` handle is process-local. Docker image has tmux installed. | **Build.** Terminal broker and independent worktree shell; attach/detach, resize, scrollback, read-only default, exclusive input lease. |
| Local control API | Task 201: the coordinator serves protocol v1 (HTTP/JSON over an owner-only Unix socket plus a token): snapshot, cursor event stream, scoped command enqueue/ACK. `runs-active --via-control` and `orc control` use it; other CLI and MCP paths still call libraries directly. | **Adapt.** Add the loopback TCP listener for the host (chosen in Task 195; packaged in Task 206), add per-session secrets, wire command delivery, then move the remaining CLI/MCP paths and the desktop onto shared services. |
| Container | `docker/dev` is a development shell, with a persistent home volume and host GitHub config mount; it does not run a project daemon. | **Adapt/build.** One long-lived non-root project container, scoped auth/runtime volumes, project bind mount, loopback control transport, preflight, no host home or Docker socket mount. |
| Desktop | No desktop app; Ink TUI exists under `lib/tui`. | **External.** Build in the private application repository against the public control API. Retain Ink/CLI here. |

## Proposed modules and ownership

```text
backlog/*.md + plans/*.md
  -> documentIndexer (rebuildable hash/validation index)
  -> dispatchPlanner + taskRouting (retained)
  -> runManager (claim, pinned spec, lifecycle, worktree/finalization)
       -> runtimeStore (SQLite migrations, transactional rows + events)
       -> commandQueue (dedupe, delivery/ACK/outcome reconciliation)
       -> sessionSupervisor -> ProviderRuntime (structured or legacy PTY)
       -> terminalBroker (provider TUI, separate worktree shell, leases)
  -> statusProjection + eventSubscription (snapshot then cursor)
  -> authenticated control server -> CLI/MCP; desktop later
```

`runtimeStore` is the sole authority for migrated operational fields. The
document index never owns task content. `runManager` retains coordinator-owned
Git finalization, and `sessionSupervisor` owns provider process lifecycle so
coordinator restart can reconcile instead of blindly terminating it. Run IDs
remain distinct from stable agent and provider session IDs. The daemon exposes
one actor-scoped command path; the desktop renderer never mutates SQLite or
controls Docker directly.

## Decisions and deviations

1. **Storage:** Extend the existing `events.db` rather than create a second
   operational database. Use schema migrations and per-field cutover. Keep
   `memory.db` separate because it is independent agent memory. A transaction
   writes each operational transition and event together. Backups and rollback
   are required before removing JSON writers.
2. **Provider transport:** Retain the current CLI/PTy adapter during migration.
   Codex app-server and Claude structured integrations remain conditional on a
   real subscription-authenticated smoke test, with inherited API-key settings
   checked. Gemini stays CLI initially. No paid inference API fallback.
3. **Container:** `docker/dev` is a starting image, not the runtime contract.
   Use one project container with a read/write project bind mount plus narrowly
   scoped login/runtime volumes. The mounted project is exposed to agents.
   Never mount host home or Docker socket. Host to container control uses
   authenticated loopback TCP (`127.0.0.1` publish plus bearer token), verified
   on the macOS host in Task 195; in-container clients keep the Unix socket.
4. **Terminal ownership:** `node-pty` continues as a legacy launch/log tool;
   tmux or a dedicated broker provides cross-process attachment. A lease grants
   exclusive input, while observers remain read-only. A lease does not pause
   an active provider turn.
5. **Existing two-root layout:** The brief depicts one project repo. A
   registered project keeps its state outside the target repo, whose
   worktrees it creates; legacy attached and sibling installations no longer
   run and must be migrated with `orc project migrate` (plan 3).
6. **Existing finalization:** The brief says the daemon resolves conflicts;
   current direct mode can ask a worker for a finalize rebase. Preserve this
   behavior initially and model it explicitly in the run state. A separate
   policy change would need its own test and migration.

## Gates and proof of concept work

Before structured adapters: record installed versions, login state, billing
selection, local protocol frames, resume behavior, approval behavior, exit and
disconnect cases for one Codex and one Claude run. These tests are opt-in and
must never require API keys. If a provider cannot prove subscription usage,
retain its CLI path. Separately prove tmux attachment from another process,
coordinator restart while a worker stays alive, and host-to-container control
transport on the user's host OS. Record exact commands and sanitized evidence.

Implementation order is in `backlog/194-*.md` onward. The first code change is
dependency sync because publishing this backlog before that repair could dispatch
tasks out of order; event sequence atomicity follows as Task 209. Do not merge
the dependent task set until Task 194 has landed. No desktop code begins until SQLite transitions,
command delivery, control API, and session recovery pass their gates. Preserve
CLI/TUI behavior and run the full suite at each migration step.
