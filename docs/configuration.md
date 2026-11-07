# Configuration

Settings live in the global registry (`orc project config`); `ORC_*` environment variables override them. Nothing reads a config file in the repository.

## Projects and data home

- `registry.db` (registered repositories + non-secret settings) lives in the data home: `ORC_DATA_HOME`, else `~/Library/Application Support/orc-state` (macOS) or `${XDG_DATA_HOME:-~/.local/share}/orc-state` (Linux).
- Each project gets a stable id and a state directory `<data-home>/projects/<id>/` holding state, run worktrees (`worktrees/<run_id>`), logs, plans and exports. Files: [contracts.md → State Files](contracts.md#state-files).
- Git operations run against the registered target repository; only Git's own worktree metadata lands in its `.git`.
- Without a registered project, `init`, `start-session`, the coordinator, the MCP server and every state-changing command refuse to run; `doctor`/`preflight` exit 1.

```bash
orc project add /path/to/repo --name=my-project
orc project list
orc project select <project-id>
orc project show --project=<project-id>
```

### Project selection

First match wins:

1. `--project=<id>` on any command.
2. `ORC_PROJECT_ID` (set for launched sessions).
3. The current directory's canonical Git root (worktrees and symlinks resolve to the owning repository).
4. `orc project select <id>`, only outside every Git repository.

An unknown or ambiguous match is an error. Switching projects writes no repository file and leaves provider logins untouched. `status`, `watch`, `doctor` and `preflight` print `project: <name> (<id>) → <target root>` (JSON: a `project` object).

### Project tasks

Tasks live in the project's `runtime.db`; `backlog.json` is a read-only projection. Status is runtime-owned: [contracts.md → Task Lifecycle](contracts.md#task-lifecycle).

```bash
orc project task create --feature=app --title="Add login" [--body-file=spec.md] [--depends-on=app/setup] [--priority=high]
orc project task edit app/add-login --expected-revision=1 [--title=...]
orc project task show app/add-login [--revision=1]
```

- Every edit creates an immutable revision (SHA-256 content hash). `--expected-revision` must be current; a no-op edit creates nothing.
- Title defaults to the first `# ` heading; acceptance criteria to an `Acceptance criteria` checklist.
- A claimed run is pinned to the latest revision; later edits affect future runs only.
- Same API: MCP `create_task`/`update_task`/`get_task`; control API `GET|POST /v1/tasks…` (stale revision → `409`).

### Markdown import and export

```bash
orc project task import ~/specs/ [--strict]         # file or directory (recursive, skips legacy/)
orc project task export ~/exports/ [--ref=app/login]
orc project plan import plans/3-foo.md
orc project plan export 3 ~/exports/plans/
```

- One-way and explicit; nothing is watched or synced.
- Import reads `ref`, `feature`, `title`, `priority`, `required_provider`, `review_level`, `merge_strategy`, `task_type`, `model`, `depends_on`. Lifecycle fields (`status`, `attempt_count`, `owner`, …) are ignored and listed in `ignored_fields`; `--strict` rejects them. A non-`todo` `status` cannot create a task.
- For an existing ref the file is the whole definition (omitted fields are cleared). One transaction per import.
- Export writes definition fields plus `spec_revision` and `content_hash`, never `status`. Re-importing a stale export fails with a revision conflict.
- Plans: format in [plan-template.md](plan-template.md); stored whole, exported byte-for-byte.

### Security model

Canonical: [contracts.md → Local Control API](contracts.md#local-control-api).

- Worker lifecycle commands go to the coordinator over `ORC_CONTROL_SOCKET`, authenticated by the session's `ORC_SESSION_SECRET`; workers never write the state directory.
- The master acts with `ORC_MASTER_SECRET`; operator shells with `<state>/operator.token`.
- A project coordinator requires the control API (refuses `ORC_CONTROL_API=off`).
- A secret is only as private as the sandbox: `full-access` workers can read other processes' environments.

## Environment variables

### Paths and transport

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_DATA_HOME` | Registry and `projects/<id>` directory | Platform data dir |
| `ORC_PROJECT_ID` | Select a registered project | — |
| `ORC_STATE_DIR` | Set for launched sessions: resolves the project from `project.json` without the registry. Selects no project on its own | Project state dir |
| `ORC_WORKTREES_DIR` | Run worktree directory | `<state>/worktrees` |
| `ORC_SESSION_TRANSPORT` | Worker sessions: `auto` (tmux if installed, else node-pty), `tmux`, `pty`. tmux sessions survive a coordinator restart. The master always runs in tmux | `auto` |
| `ORC_TMUX_BIN` | tmux binary | `tmux` |
| `ORC_CONTROL_API` | Serve the control API (`control.sock`, `control.json`, `control.token`) | on |
| `ORC_CONTROL_RETRY_MS` | Retry window for worker lifecycle commands while the coordinator is unreachable | `120000` |
| `ORC_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, `silent` | `warn` |
| `ORC_SCOUT_READY_TIMEOUT_MS` | How long `request_scout` waits for the scout to report for duty | `60000` |

### Providers and pools

| Variable | Setting | Default |
|----------|---------|---------|
| `ORC_DEFAULT_PROVIDER` | `default_provider` | — |
| `ORC_DEFAULT_EXECUTION_MODE` | `default_execution_mode` | — |
| `ORC_MASTER_PROVIDER` | `master.provider` | `claude` |
| `ORC_MASTER_MODEL` | `master.model` | provider default |
| `ORC_MASTER_EXECUTION_MODE` | `master.execution_mode` | `full-access` |
| `ORC_MAX_WORKERS` | `worker_pool.max_workers` | `0` |
| `ORC_WORKER_PROVIDER` | `worker_pool.provider` | `codex` |
| `ORC_WORKER_MODEL` | `worker_pool.model` | provider default |
| `ORC_WORKER_EXECUTION_MODE` | `worker_pool.execution_mode` | `full-access` |
| `ORC_WORKER_RUNTIME` | `worker_pool.runtime` | `cli` |
| `ORC_WORKER_SANDBOX_NETWORK` | `worker_pool.sandbox_network` | `restricted` |
| `ORC_SESSIONS_RESUME` | `sessions.resume` | `auto` |

### Set for launched sessions

| Variable | Meaning |
|----------|---------|
| `ORC_PROJECT_ID`, `ORC_STATE_DIR` | Project identity and state dir |
| `ORC_SESSION_ID` | Session id (not a credential) |
| `ORC_SESSION_SECRET` | Worker/scout credential (environment only; only its hash is stored) |
| `ORC_MASTER_SECRET` | Master credential |
| `ORC_CONTROL_SOCKET` | Coordinator control socket |

## Settings

Registry keys, global or per project (project wins); dotted keys for nested fields. Every key is optional.

```bash
orc project config set default_provider claude
orc project config set worker_pool.provider_models.claude sonnet
orc project config set --global master.model opus
orc project config list            # effective values; --global shows stored global values
orc project config unset worker_pool.max_workers
```

For Claude models prefer the aliases `sonnet`, `opus`, `haiku`.

### Top level

| Key | Default | Description |
|-----|---------|-------------|
| `default_provider` | — | Fallback provider for master and workers (`claude`, `codex`, `gemini`) |
| `default_execution_mode` | `full-access` | Fallback execution mode (`full-access`, `sandbox`) |

### `master`

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | `claude` | Master provider |
| `model` | `null` | Master model |
| `execution_mode` | `full-access` | Master execution mode |

### `worker_pool`

Workers are spawned on demand per task and removed after it; there are no idle workers.

| Field | Default | Description |
|-------|---------|-------------|
| `max_workers` | `0` | Max concurrent task workers (`orc init` sets `1` when unset) |
| `provider` | `codex` | Worker provider; a task's `required_provider` wins |
| `model` | `null` | Worker model |
| `provider_models` | `{}` | Per-provider model; wins over `model` |
| `execution_mode` | `full-access` | Worker execution mode |
| `runtime` | `cli` | `cli` or `structured` ([Worker Runtimes](#worker-runtimes)) |
| `sandbox_network` | `restricted` | Sandboxed control-socket access ([Execution Modes](#execution-modes)) |

### `sessions`

| Field | Default | Description |
|-------|---------|-------------|
| `resume` | `auto` | `auto` resumes a crashed worker session in place; `off` requeues its run ([Session Resume](#session-resume)) |

### `coordinator`

Times in ms. Behaviour of the liveness thresholds: [contracts.md](contracts.md).

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `autonomous` | Coordinator mode |
| `tick_interval_ms` | `30000` | Tick interval |
| `concurrency_limit` | `8` | Per-tick parallelism of dispatch/nudge work (the worker cap is `max_workers`) |
| `run_start_timeout_ms` | `600000` | Dispatched run not started → failed |
| `session_ready_timeout_ms` | `120000` | Wait for a worker session to be ready |
| `session_ready_nudge_ms` | `15000` | First nudge to an unready session |
| `session_ready_nudge_interval_ms` | `30000` | Session-ready nudge interval |
| `run_inactive_nudge_ms` | `600000` | First nudge to an inactive run |
| `run_inactive_nudge_interval_ms` | `300000` | Inactivity nudge interval |
| `worker_stale_soft_ms` | `1800000` | `worker_needs_attention` alert |
| `worker_stale_nudge_ms` | `3600000` | Stale nudge |
| `worker_stale_force_fail_ms` | `7200000` | Force-fail with `policy: requeue` |
| `hook_idle_nudge_ms` | `300000` | Nudge for runs with tool hooks (Claude) |
| `hook_idle_escalate_ms` | `600000` | Alert for runs with tool hooks |
| `run_no_progress_escalate_ms` | `3600000` | Alive but no progress → `worker_needs_attention {reason: "no_progress"}` |
| `memory_prune_interval_ms` | `3600000` | Memory prune interval; `0` disables (settings only) |
| `merge_strategy` | `direct` | `direct` or `pr` |
| `pr_provider` | `null` | `github`; required for `pr` |
| `pr_push_remote` | `origin` | Remote for PR branches |
| `pr_finalize_lease_ms` | `86400000` | Lease during PR finalization |
| `run_inactive_timeout_ms`, `run_inactive_escalate_ms`, `session_start_max_attempts`, `session_start_retry_delay_ms` | — | Unused; accepted so stored settings load |

`coordinator.ts` flags override settings: `--interval-ms`, `--mode`, `--run-start-timeout-ms`, `--session-ready-timeout-ms`, `--session-ready-nudge-ms`, `--session-ready-nudge-interval-ms`, `--run-inactive-nudge-ms`, `--run-inactive-nudge-interval-ms`, `--memory-prune-interval-ms`, `--worker-stale-soft-ms`, `--worker-stale-nudge-ms`, `--worker-stale-force-fail-ms`, `--hook-idle-nudge-ms`, `--hook-idle-escalate-ms`, `--run-no-progress-escalate-ms`. Other keys have no flag.

### `leases`

| Field | Default | Description |
|-------|---------|-------------|
| `default_ms` | `1800000` | Claim lease; renewed on each phase/progress event |
| `finalize_ms` | `3600000` | Lease after `run-work-complete` while awaiting finalization |

## Resolution Order

1. CLI flag
2. Environment variable
3. Section setting (project over global)
4. `default_provider` / `default_execution_mode`
5. Built-in default

## Worker Runtimes

| Runtime | Behaviour |
|---------|-----------|
| `cli` (default) | Provider's interactive CLI in a terminal (tmux or PTY); input is unacknowledged typed text. |
| `structured` | Codex runs `codex app-server --listen stdio://` (session `app:<agent_id>`). Other providers stay on `cli` and record `provider_ref.runtime_fallback`. |

Codex app-server:

- Subscription only: API-key env vars are removed; a non-ChatGPT account fails with `unverified_auth`.
- Every coordinator message is a durable command (`accepted` → `running` → `completed`/`failed`); the task envelope is keyed per run.
- Input is delivered between turns only; nudges skip a mid-turn worker; `FINALIZE_SUCCESS` is not delivered.
- The handshake marks the session ready (no `report-for-duty`).
- Steering, interrupt and approvals are refused (`unsupported_capability`); threads run with `approvalPolicy: never`.
- A crashed app-server is resumed on its thread (`thread/resume`, [Session Resume](#session-resume)). The session ends with the coordinator that launched it; that run is requeued. Roll back with `runtime: cli`.

## Session Resume

When a task worker's provider process dies mid-run, the coordinator resumes it in place instead of requeueing the run: same claim, `session_id`, worktree, environment, `--settings` (hooks, sandbox) and MCP isolation. The session gets a new secret (the old one is rejected) and its `generation` goes up by 1. The bootstrap is not resent; the worker gets a `SESSION_RESUMED` message with the run's phase and last progress time.

| Provider / runtime | Resume |
|--------------------|--------|
| Claude CLI (tmux or PTY) | Yes: orc starts the conversation with `--session-id <uuid>` and relaunches with `--resume <uuid>` |
| Codex `structured` (`app:`) | Yes: `thread/resume` on the recorded thread id |
| Codex CLI | No |
| Gemini | No |

The run is requeued as before when any of these holds:

- `sessions.resume` is `off`.
- The provider or runtime cannot resume (table above).
- The exit was not a crash: a clean exit after `run-work-complete` (`finished`), a clean exit before it such as `/exit` (`user_exit`), or no observed exit status (`unknown`).
- The run worktree is gone (Claude keeps conversations per working directory).
- The run already resumed twice (budget 2 per run).

A crash is a signal or a non-zero exit code. tmux keeps the dead worker pane (`remain-on-exit`, set per worker window) so its status can be read; telling a signal kill apart needs tmux 3.3 or later, older tmux reports it as `unknown`. An invalid `sessions.resume` value is logged and treated as `off`. PTY and `app:` exits are seen only by the coordinator that launched the process.

Events: `session_resumed` on success. `session_resume_failed` when the budget is spent or the relaunch fails; the run is then requeued.

## Execution Modes

| Preset | Behaviour |
|--------|-----------|
| `full-access` (default) | No sandbox. |
| `sandbox` | Writes confined to the worktree (+ grants below); unsandboxed commands disallowed. |

Set with `default_execution_mode`, `master.execution_mode`, `worker_pool.execution_mode` (most specific wins) or the `ORC_*_EXECUTION_MODE` variables.

| Provider | `full-access` | `sandbox` | Control socket in `sandbox` |
|----------|---------------|-----------|-----------------------------|
| Claude | `--dangerously-skip-permissions` | `--permission-mode auto` + settings file: `allowUnsandboxedCommands: false`, `allowWrite` grants | macOS: allowed by path. Linux: only with `sandbox_network: open` (`allowAllUnixSockets: true`) |
| Codex | `--dangerously-bypass-approvals-and-sandbox` | `--sandbox workspace-write --ask-for-approval never` + writable roots | Only with `sandbox_network: open` (`sandbox_workspace_write.network_access=true`: full network) |
| Gemini | no flags | no flags (no sandbox flag exists) | n/a |

- Sandbox write grants: the worktree, the control socket, and the target's `.git/objects`, `refs`, `logs`, `worktrees`. Never `.git/hooks`, `.git/config`, the state directory or the target working tree.
- Claude sandboxes cannot read `operator.token`; Codex sandboxes can.
- Workers and scouts never start the master's orchestrator MCP server (Claude `--strict-mcp-config`; Gemini `--allowed-mcp-server-names`; Codex `-c mcp_servers.orchestrator={command="true",enabled=false}`).
- `orc doctor` and coordinator startup warn when the default worker provider cannot reach the socket.

> **Warning:** `sandbox_network: open` on Linux lets a sandboxed Claude session reach **every** Unix socket (Docker daemon, SSH agent, orc's tmux server). Use it only where those are unreachable; otherwise use `full-access`.

### Codex

```
-c sandbox_workspace_write.writable_roots=["<control-socket>","<target>/.git/objects","<target>/.git/refs","<target>/.git/logs","<target>/.git/worktrees"]
```

These override keys were not verified against a live Codex sandbox. If sandboxed commits or `orc` calls fail, check them against your `codex` version (`codexSandboxWritableRootArgs` / `codexSandboxNetworkArgs` in `adapters/pty.ts`).

### Scouts

- Scouts launch with `read_only: true`: Codex sandbox → `read-only`; Claude sandbox → no `allowWrite`.
- In `full-access`, `read_only` has no effect.
- A read-only Codex scout has no network, so it cannot report for duty in a project; request a `claude` scout (on Linux with `sandbox_network: open`, which makes it no longer strictly read-only).

### Linux prerequisites (Claude sandbox)

Install `bubblewrap` and `socat` (`apt-get install bubblewrap socat` / `dnf install bubblewrap socat`); macOS needs nothing. `orc doctor` checks them.
