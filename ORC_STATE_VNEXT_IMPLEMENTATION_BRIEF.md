# orc-state vNext: Local Multi-Agent Workbench

**Implementation brief for a coding agent**  
**Repository:** https://github.com/t-mu/orc-state  
**Status:** Target architecture and incremental migration plan; verify against the checked-out code before implementation.

## 0. Instructions to the implementing agent

Read the existing repository before making architectural changes. Start with `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/contracts.md`, `coordinator.ts`, `adapters/`, `lib/eventLog.ts`, `lib/claimManager.ts`, `lib/backlogSync.ts`, `lib/workerRuntime.ts`, `lib/runWorktree.ts`, `cli/`, `mcp/`, `docker/dev/`, and the existing test suites. Names and locations may have changed; search by responsibility rather than assuming this brief is a precise reflection of HEAD.

Treat this document as **product intent and architectural direction**, not a mandate for an immediate rewrite. First produce a gap analysis mapping each requirement to existing code: **reuse / adapt / build / defer**. Create small, reviewable work items with dependencies and acceptance tests. Then implement vertical slices. Preserve the working CLI and task lifecycle until the replacement path is verified. Record tradeoffs in short architecture decision records (ADRs). Do not silently change task formats, authentication, or billing behavior.

## 1. Product vision

Evolve orc-state from a portable, CLI-first, file-oriented agent orchestrator into a **reliable personal, local-first, multi-provider agent workbench**.

The primary user experience is a desktop application with a sidebar of projects, active agents and recent runs. Selecting an agent shows its task, structured activity, conversation/logs, Git changes, blockers and an interactive shell when needed. A user can inspect, intervene and resume work without disrupting unrelated workers.

The orchestrator should support a Claude master coordinating Codex/Claude/Gemini workers, workers requesting help or reviews from each other, and human intervention as another first-class participant. Communication must be robust across process crashes, GUI reconnects and transient provider failures.

**Priority order:** reliability > local inspectability > effective intervention > developer ergonomics > portability / general-purpose packaging.

## 2. Non-negotiable decisions and invariants

1. **Subscription-backed inference only.** Use installed, locally authenticated provider tools and provider-specific local integration protocols. Do not silently introduce pay-per-token inference API calls, API-key-based billing or a hosted model gateway. A local RPC/WebSocket used for desktop control is acceptable; it is not a model inference API. Verify login and billing mode with a real smoke test before adopting any SDK or app-server integration. If a specific SDK path cannot demonstrably use the user's plan, use a subscription-authenticated CLI path instead.
2. **One shared Docker container per project environment** is the default. The coordinator, master and workers run as separate processes within that container. Do not implement per-agent containers initially. Git worktrees separate code editing, not security domains. Agents may coordinate and inspect other worktrees when useful.
3. **Isolate the host.** No general mount of the user's home directory, no host Docker socket inside the container, no privileged container, and no unnecessarily exposed network service. A read/write bind mount of the project is a deliberate exception: it protects the rest of the host, but NOT the mounted project. Document this explicitly. Optionally support a stronger private-volume/clone mode later.
4. **Human-reviewable task files remain canonical.** Keep backlog/plans/specifications as Markdown in the project repository, accessible to `cat`, IDEs and `git diff`. Do not turn SQLite into the sole copy of task content.
5. **SQLite owns operational truth.** Use it for durable run/session state, commands, agent-to-agent messages, acknowledgements, event history and recovery cursors. Files may continue as derived caches during migration but must not permanently compete as authoritative stores for the same state.
6. **Preserve the existing Git worktree model and lifecycle** initially: dependency-aware dispatch, run claiming, testing, review, finalization and merge. Avoid unrelated scheduling rewrites.
7. **Provider protocol != terminal protocol.** Prefer structured provider integration for reliable instructions, approvals and lifecycle events. Use tmux/PTY for real terminals and human intervention. Raw terminal keystrokes must not be treated as semantic delivery acknowledgements.
8. **Incremental migration with rollback.** CLI/TUI use must remain possible even while the desktop is incomplete. Add schema migrations, compatibility readers or a temporary dual-read adapter where needed. Never run two competing authoritative writers indefinitely.

## 3. Target architecture

```text
Host operating system
  Desktop app (Electron + React; privileged actions in main process)
  Docker lifecycle launcher / project selector
     | authenticated, localhost-only control connection
     v
+---------------------------------------------------------------+
| Long-lived shared orc project container                        |
|                                                               |
|  orc daemon / coordinator                                      |
|    - scheduler, run lifecycle, Git finalization                 |
|    - SQLite commands, events, projections and recovery         |
|    - task file watcher / Markdown index                        |
|    - authenticated local control API                           |
|                                                               |
|  session supervisors / provider adapters                       |
|    - Master: Claude, Codex, etc.                                |
|    - Worker A: structured local provider process               |
|    - Worker B: structured local provider process               |
|    - Optional legacy terminal-backed provider via tmux        |
|                                                               |
|  Shared project repo + backlog/*.md + plans/*.md               |
|  Separate per-run Git worktrees                                |
|  Per-run task snapshots, logs, terminal sessions               |
|  Durable runtime data on a persistent volume                   |
+---------------------------------------------------------------+
```

The desktop is **a client** of the daemon, not a second coordinator. The host manages the Docker container's lifecycle; the container does not receive the host Docker control socket. A CLI client and MCP tools should use the same core services as the GUI.

Inside the container use Unix-domain sockets where convenient. For the host desktop, bridge the control API through an authenticated, strictly loopback-bound local endpoint or an equivalent Docker transport. Do not expose that endpoint to the LAN. Use typed, versioned requests and subscriptions for events.

## 4. Functional design

### 4.1 Tasks and Git workspaces

- Retain `backlog/*.md`, `plans/*.md` and existing metadata conventions as the canonical, editable specifications. Reuse current parsing, dependency and scheduling rules where feasible.
- Index documents into SQLite by stable task reference, path, last-seen content hash and validation status. The index is rebuildable from files.
- At dispatch, pin a **task revision** (content hash plus captured Markdown snapshot). Store the pinned revision with the run. Editing the original task during execution must not silently change the worker's instructions; mark the run as operating on an older spec and offer explicit redispatch/revision actions.
- Launch the worker process with its **actual cwd** set to its assigned worktree, not just instructions telling it to `cd` there. Make all provider sandbox paths and Git metadata access consistent with the selected workspace.
- Give each worker its pinned task content as an initial structured instruction and/or a local run-input file. The shared container can still expose other project docs for context.
- Preserve Git worktrees at first. The daemon remains responsible for conflict resolution and merges; do not introduce per-run clones unless an observed problem justifies it.
- Keep generated task edits, plans and backlog diffs easy to inspect from both CLI and desktop. Optional human approval before dispatch should be a configurable workflow, not an unavoidable blocker.

### 4.2 Reliable state, messages and event delivery

Existing SQLite events are a good foundation, but **an append-only event log alone is not a durable message queue**.

Introduce explicit operational tables, or equivalent transactional projections, for:

- `runs` and `agent_sessions` (stable agent ID, unique run ID, unique provider session ID, state, ownership and recovery metadata);
- `commands` (command ID, sender/recipient, run scope, type, payload, correlation/idempotency keys, status, attempts and timestamps);
- `messages` / `input_requests` (semantic conversation and blockers, including response and consumption state);
- `consumer_offsets` (durable event-stream cursors);
- `control_leases` (exclusive human terminal input or operator takeover, if applicable).

Each state transition should append its event **in the same SQLite transaction**. Eliminate `SELECT MAX(seq) + 1` outside a write transaction; use SQLite-allocated sequence numbers or serialized allocation. Replace full-history event scans and JSON checkpoint dependence with incremental cursors (`seq > last_seq`) and replay-on-restart. Keep WAL and the event query/search abilities already present.

Command delivery states should distinguish **queued, dispatching, sent, accepted, running, completed, failed, cancelled, and outcome_unknown**. A successful write to stdin or a PTY is only `sent`. Mark `accepted` only when a meaningful provider or explicit worker acknowledgement exists. Completion comes from actual turn/run outcomes. Support at-least-once delivery with deduplication, bounded retries, timeouts, and reconciliation; do not claim exactly-once execution. Never blindly replay a possibly executed side-effecting command after a crash.

Event-driven wakeups should deliver new commands promptly. Retain a periodic timer for health, leases, cleanup and missed notifications. All operations must be scoped to the requesting actor and run; untrusted text is not a privileged control command.

### 4.3 Local provider abstraction

Keep a common `AgentRuntime` / `ProviderAdapter` interface with operations conceptually like:

```ts
start(config); resume(sessionRef); send(command);
subscribeEvents(sessionRef, cursor); interrupt(sessionRef);
getCapabilities(); stop(sessionRef);
```

Normalize events such as session started, turn started, text delta, tool call, approval required, question raised, command accepted, turn completed, error and session stopped. Preserve provider-specific metadata in an extension field and declare capabilities: streaming, resume, mid-turn steering, interrupt, approval, interactive TUI, etc. Do **not** assume every provider supports every operation.

Suggested first investigations:

- **Codex:** local `codex app-server` over stdio, structured JSON-RPC, thread/turn lifecycle and approvals, authenticated through the user's ChatGPT/Codex plan.
- **Claude:** Claude Agent SDK or local Claude Code JSON-streaming CLI, only after proving subscription-authenticated usage. Avoid inherited API key settings that could select metered billing.
- **Gemini:** retain the existing CLI adapter initially; investigate structured support separately, and do not hold up the MVP on full feature parity.
- **Legacy:** continue supporting PTY/tmux-backed CLI execution as a fallback and debugging route.

Before building the entire abstraction, create a **subscription and protocol proof-of-concept** for one Codex run and one Claude run. Record exact versions, authentication prerequisites, session resume behavior, event formats, permission/approval behavior and failure cases. Use fake adapters for deterministic automated tests; real-provider tests should be opt-in and never require paid API keys.

### 4.4 Sessions, terminals and human intervention

Distinguish three user experiences:

1. **Structured conversation/activity:** agent messages, tool use, approvals and errors from the provider protocol.
2. **Running agent terminal:** true interactive attachment to a provider CLI when the worker uses a terminal-backed mode. Use `tmux` for persistent, attachable sessions. `node-pty` can be retained where useful but must not be assumed to provide cross-process attachment on its own.
3. **Worktree shell:** a *separate* interactive shell, started in the worker's worktree, for investigation, tests and manual repair. Available even when the provider runs headlessly.

Implement a terminal broker supporting attach, detach, input, resize, exit, output subscription, scrollback and retained per-run logs. Make read-only observation the default for a provider's live TUI. Require explicit temporary ownership for write control; avoid simultaneous daemon and human terminal input. A control lease does not itself pause an already running provider turn.

A daemon restart should not necessarily kill worker sessions. For structured stdio integrations, this requires a session-owning runner/supervisor independent of the coordinator, or explicit recovery/resume logic. `tmux` helps terminal-backed sessions survive coordinator restart but not full container destruction. Record enough metadata in SQLite to reconcile actual processes after restart.

Expose useful CLI operations (names illustrative): `orc runs`, `orc logs <run> --follow`, `orc attach <run>`, `orc shell <run>`, `orc messages <run>`, `orc respond <request>`, `orc inspect --json`. Fix the existing `control-worker` behavior rather than merely relabeling read-only log output as interactive control.

### 4.5 Container boundary and authentication

Provide a reproducible, long-lived **one-container-per-project** setup based on the repository's existing Docker development assets. Install provider CLIs, Node/tooling, Git and tmux in the image. Persist subscription login state, workspace and runtime data across container recreation using scoped volumes, not a mount of the entire host home.

Baseline hardening: non-root processes, no `--privileged`, no host Docker socket, restricted mounts, dropped unnecessary capabilities, no-new-privileges, resource/pid limits and localhost-only control access. Use explicit network policy; provider cloud access and necessary package tooling must still work. Credentials accessible to shared-container agents are within the shared trust domain; do not claim per-agent secrets isolation. Consider a separate daemon UID and protected state directory to reduce accidental corruption.

Support/document two workspace modes:

- **Convenience (initial default):** bind-mount the chosen project read/write; Markdown backlog and code diffs appear immediately on host. A compromised agent can still damage that mounted project.
- **Stronger isolation (optional later):** private project clone/workspace on a Docker volume with explicit import/export or reviewed Git sync. This protects the original host checkout but complicates the direct-edit workflow.

Do not let the framework silently switch between these modes. Provide a preflight that checks project paths, UID/GID ownership, writable worktrees, Git metadata access, provider login, Docker permissions and required tooling before dispatching work.

### 4.6 Cross-provider and peer-to-peer collaboration

Route semantic messages through the daemon and SQLite rather than relying on peers typing into one another's terminals. Support master-to-worker, worker-to-master and **worker-to-worker** messages, plus human responses. Messages should include IDs, sender/recipient, run and task references, optional referenced artifacts, delivery state and timestamps. Add first-class request-for-review, question, feedback and result types; do not force every conversation into a plain task instruction.

Agents may inspect other worktrees in the shared container where allowed by project policy. Prefer Git refs, file paths, diffs and structured task artifacts to copying huge conversation transcripts. Cross-provider context is explicitly transferred; provider-private context is not magically shared. Apply run-level permissions to state-changing daemon operations even though agents share a container.

### 4.7 Desktop application

Build only after the daemon offers a stable read/command interface. A reasonable first stack is **Electron + React + xterm.js**, reusing TypeScript types and status projections; the Electron renderer must not hold raw Docker or filesystem privileges.

MVP views:

- **Project selector + left sidebar:** active master, active workers, status badges, blocked sessions, recent runs.
- **Run inspector:** Markdown task specification (with pinned revision), provider/model, worktree path, execution state, Git diff and finalization status.
- **Activity and logs:** normalized provider events, searchable SQLite event timeline, raw/printable logs with live follow.
- **Terminal tab:** independent worktree shell; real provider TUI attachment where supported.
- **Operator actions:** respond to questions/approvals, interrupt, retry or cancel, take/release terminal control.

Startup must restore the UI from a daemon snapshot and stream events from a cursor so reconnect does not lose updates. The GUI is optional: existing CLI workflows continue functioning if the desktop app is closed.

## 5. Implementation sequence: small vertical slices

### Phase 0 - Inventory, decisions and executable proof-of-concepts

Deliver a repository audit, architecture map, ADRs, and dependency-ordered backlog tasks. Run current unit/e2e tests and record baseline failures. Prototype Claude and Codex subscription-authenticated structured calls *without* changing orchestration. Prototype a live tmux attach from a second process. Decide the initial host-to-container control transport from actual OS/Docker behavior.

**Gate:** Document which local protocols demonstrably work on the user's subscription, and identify the minimal refactor path for the existing code.

### Phase 1 - Reliable persistence and messaging

Fix SQLite event append concurrency, introduce transactional runtime mutations, command records, ACK semantics, deduplication and consumer cursors. Keep compatibility with existing JSON state until migrated; use explicit migration/rollback scripts and tests. Retain Markdown backlog as source of truth.

**Gate:** Concurrent writers, duplicate messages and simulated crashes do not silently lose commands or produce duplicate task execution.

### Phase 2 - Daemon control plane and session ownership

Extract coordinator responsibilities into composable scheduler/run manager/command dispatcher/status projection components. Add a versioned local control API consumed by both CLI and future desktop. Add session identity, supervision and restart reconciliation. Preserve the existing dispatch and finalization semantics.

**Gate:** A separate client can list live runs, read events and send a scoped command; reconnect/restart preserves recoverable state.

### Phase 3 - Structured provider adapters

Implement one real provider end-to-end through the new command path, then a second provider. Add normal event normalization and capability detection. Keep legacy PTY mode as fallback. Prevent API-key billing paths by default and surface authentication errors clearly.

**Gate:** A task can be assigned, acknowledged, worked, questioned, answered and completed by two distinct subscription-backed providers.

### Phase 4 - Shared Docker runtime, worktree shells and attach/control

Package daemon plus agents in one persistent project container. Set working directories correctly; keep task Markdown and worktrees accessible. Integrate tmux for interactive provider terminals and independent worktree shells. Retain output across runs. Add Docker/container reconciliation and command-line shell access.

**Gate:** Host files outside explicitly mounted locations are inaccessible; two parallel workers can run; a user can attach a shell and leave without terminating work.

### Phase 5 - Desktop MVP

Build project discovery/container connect, agent sidebar, task inspector, live activity, logs, shell tabs and input response UI. Render structured provider sessions without pretending they are terminal TUIs. Implement reconnect and status consistency.

**Gate:** The desktop can observe and intervene in an existing run while the CLI remains fully usable.

### Phase 6 - Collaboration, recovery and polish

Add peer messaging/review flows, stronger intervention ownership, auth/permissions UX, retention policies, resource monitoring, improved crash recovery, migration documentation and optional stronger workspace isolation. Add real-provider e2e tests behind opt-in flags.

**Gate:** Common failure/recovery paths are tested and documented, and there are no known duplicate-dispatch or silent-message-loss paths.

## 6. Test strategy and acceptance criteria

Use automated unit tests for Markdown parsing/revision pinning, SQLite transactions, reducer invariants, message state transitions, idempotency and permission checks. Use fake provider subprocesses for deterministic integration tests of partial JSON, approval interruptions, disconnects, late events, unexpected exits and resume. Add an opt-in manual/real-provider smoke matrix for Codex, Claude and eventually Gemini.

Exercise at least these failure scenarios:

- Multiple SQLite writers append events simultaneously; sequence assignment remains unique and ordered.
- Daemon crashes between writing a command and delivering it; retry/reconciliation does not double-execute a side effect.
- Provider accepts a command but crashes before final result; status becomes explicit rather than falsely completed.
- Operator edits a Markdown task while its earlier revision is executing.
- Worker A requests review from Worker B using a different provider.
- GUI disconnects/reconnects in the middle of a live event stream.
- Two users/processes try to control one terminal; one receives an explicit denial or handoff.
- Coordinator restarts while workers remain alive; running sessions are adopted or marked recoverable with explanation.
- Container is rebuilt; persisted task specs, SQLite history and login state remain available as designed.
- Host-home/Docker-socket paths are inaccessible to agent processes; project bind mount risk is correctly disclosed.

**Definition of done for vNext MVP:** From the desktop or CLI, start/connect to one project container, review Markdown backlog, launch two workers of different supported providers using existing subscriptions, observe command delivery and activity, receive/respond to a blocker, open a worker worktree shell, inspect Git changes, recover from a GUI disconnect and complete finalization without losing task or run history.

## 7. Avoid these anti-patterns

- Replacing Markdown backlog with opaque SQLite-only task bodies.
- Treating `stdin.write()` or tmux `send-keys` as proof an agent accepted an instruction.
- Using `node-pty` process-local handles as if arbitrary external processes can reattach directly.
- Giving the desktop a separate authoritative scheduler or direct SQLite mutation path.
- Restarting healthy workers merely because the coordinator process restarted.
- Mounting the host Docker socket/home directory to save setup effort.
- Claiming a shared container isolates agents from one another, or that a read/write bind mount protects the mounted project.
- Assuming a provider SDK uses subscription entitlements without verifying the current authentication path.
- Large rewrites that invalidate existing task states, Git flows and tests all at once.

## 8. Expected work products and first action

Produce: (a) `docs/vnext-architecture.md` with the validated target design; (b) a compact decision log covering storage, Docker mounts, provider transport and terminal ownership; (c) a phased Markdown backlog with acceptance criteria and dependencies; (d) a working vertical slice for durable messaging; and (e) migration/recovery documentation as the project evolves.

**First action for the implementing agent:** Inspect the current branch and produce a focused **current-state vs target-state matrix**. Identify reusable modules, concrete reliability bugs and prerequisite technology spikes. Then propose the smallest first PR that makes measurable progress (likely event-sequence atomicity plus transaction/idempotency tests). Do not build the desktop UI first. Where this brief disagrees with actual code or provider behavior, document the discrepancy and adapt the implementation without violating the product invariants above.

## References to verify during implementation

- Repository: https://github.com/t-mu/orc-state
- Current architecture: https://github.com/t-mu/orc-state/blob/main/docs/architecture.md
- Current state/lifecycle contracts: https://github.com/t-mu/orc-state/blob/main/docs/contracts.md
- Codex app-server and ChatGPT plan auth: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- Claude Agent SDK with subscription: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

Provider capabilities and subscription rules change. Treat those reference URLs as verification starting points, not immutable guarantees.
