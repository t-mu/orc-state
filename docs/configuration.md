# Configuration

orc-state is configured through environment variables and an optional JSON config file. Environment variables take precedence over config file values.

## Global project registry (new project API)

`orc project` stores registered Git repositories and non-secret settings in a global `registry.db`. Set `ORC_DATA_HOME` to choose its directory. By default it uses `~/Library/Application Support/orc-state` on macOS or `${XDG_DATA_HOME:-~/.local/share}/orc-state` on Linux. Each project receives a stable id and an external `projects/<id>` state directory. No config file or orc files are needed in the target repository to register it.

```bash
orc project add /path/to/repo --name=my-project
orc project list
orc project select <project-id>
orc project show --project=<project-id>
orc project config set worker_pool.max_workers 2 --project=<project-id>
orc project config get worker_pool.max_workers --project=<project-id>
orc project config list --global
orc project config unset worker_pool.max_workers --project=<project-id>
```

Project lookup uses `--project`, then `ORC_PROJECT_ID`, then the current repository's canonical Git root, then the selected project only outside a Git repository. An unknown or ambiguous match is an error. Settings are validated against known non-secret config keys. Effective values resolve from CLI overrides, environment, project settings, then global settings. `project config list` shows effective values; `--global` shows stored global values. Commands run against a registered project as described below; a repository that still has a legacy layout keeps using it until it is migrated.

### Running against a registered project

An orc command runs in **project mode** when `ORC_PROJECT_ID` names a registered project. Otherwise, when no legacy override (`ORC_STATE_DIR`, `ORC_HOME`, `ORC_REPO_ROOT`, `ORC_CONFIG_FILE`) is set, the current directory's canonical Git root selects its registered project (a root registered twice is an error), and outside every Git repository the project chosen with `orc project select` applies. A repository that still has a legacy `.orc-state/` or `orc-state.config.json` (between the current directory and its Git root) stays in legacy mode until it is migrated; once `orc project migrate` cuts it over, that layout, or a legacy override naming it, selects its project instead. `ORC_PROJECT_ID` overrides both. A project whose migration has not been cut over is not active yet: the repository keeps its legacy layout, and naming the project explicitly is an error. Each project state directory holds a `project.json` descriptor (id, name, target root), so a worker given `ORC_PROJECT_ID` and its state directory resolves the project without opening the global registry.

In project mode:

- State, run worktrees (`<state>/worktrees/<run_id>`), PTY logs, provider settings, plans and exports live under the project's state directory in the data home. Git operations (worktrees, branches, merges) run against the registered target repository; only Git's own worktree metadata lands in the target's `.git`.
- Settings come from the registry (`orc project config`), project over global, with environment and CLI overrides on top. No `orc-state.config.json` is read or needed.
- Workers receive `ORC_PROJECT_ID`, their session id as `ORC_SESSION_TOKEN` (their actor credential), and the control socket as `ORC_CONTROL_SOCKET`, which `orc control` and the worker lifecycle commands use in place of the recorded endpoint path; the daemon's bearer token is still read from `<state>/control.token`. `ORC_STATE_DIR` is still set as a temporary bridge, and `ORC_HOME`/`ORC_REPO_ROOT`/`ORC_CONFIG_FILE` are blanked (a blank value counts as unset) so an inherited legacy value cannot redirect them. A sandboxed worker that cannot open the registry runs on environment settings and defaults.
- Worker lifecycle commands — `run-start`, `progress`, `run-work-complete`, `run-fail`, `run-finish`, `run-input-request`, `review-submit`, `memory-record` and `report-for-duty` — do not write the state directory in a project. Each is sent to the coordinator over `ORC_CONTROL_SOCKET` with `ORC_SESSION_TOKEN`, and the coordinator applies it, so it is the only writer of `runtime.db`, `events.db` and `claims.json`. The credential must be the running session launched for the named run (and agent); `--agent-id` alone is not trusted, and a request for another run is refused with `403 forbidden`. Without `ORC_SESSION_TOKEN` these commands fail, except `memory-record`, which an operator shell still writes directly. While the coordinator is stopped or restarting a command retries for up to two minutes (`ORC_CONTROL_RETRY_MS`), and only when the request never reached it. A legacy installation keeps writing its state directory directly until it is migrated. A project coordinator therefore requires the control API: it refuses to start with `ORC_CONTROL_API=off` or when the socket cannot be served.
- Sandboxed project workers may write their worktree, the target's `.git` object, ref and worktree-metadata subtrees, and the control socket — never the project state directory or the target working tree. Claude, Codex, and the Codex app-server runtime get the same writable roots, and Claude's sandbox also allows connecting to that socket (`network.allowUnixSockets`). Read-only access (task specs, `review-read`, `memory-wake-up`, `status`) is unchanged.

### Legacy attached installations

An installation that keeps `.orc-state/`, `backlog/` and `orc-state.config.json` inside its repository still runs until it is migrated, and `orc doctor`/`orc preflight` remind you to migrate it. Its coordinator registers task **definitions** from `backlog/` specs (a new spec is added as `todo`; titles, dependencies, review level and merge strategy follow their specs). Status is never read from a spec and never written back: runtime commands own it (`run-fail`, `task-reset`, `task-unblock`, the coordinator's merge), workers do not edit `status:`, and a new spec whose `status:` is not `todo` is not registered (`orc backlog-sync-check` lists it as skipped; `orc project migrate` carries such tasks with their status). The sibling layout is retired: a config with a separate `target_repo` is refused until migrated.

### Selecting and switching projects

Every `orc` command accepts `--project=<id>` (or `--project <id>`), before or after the subcommand; it is the highest-precedence selector and an unknown id is an error. Inside a registered repository the repository selects its project; outside every repository `orc project select <id>` sets the default. Switching changes only the registry selection or the flag — no repository file is written, and provider logins are untouched because they live in the providers' own stores.

`orc status`, `orc watch` (TUI header), `orc doctor` and `orc preflight` print the active project (`project: <name> (<id>) → <target root>`; JSON output carries a `project` object). In project mode `doctor` and `preflight` check the target repository, the state directory, the project task store, and warn about orc artifacts left in the target working tree; the Markdown backlog-sync check is skipped. `orc start-session` passes the project identity to the coordinator and the master's MCP server; a Codex master receives its MCP server as `-c` overrides instead of a `.codex/config.toml` in the repository. The control API snapshot carries the project identity, and each run row its task's SQLite `task_status` and pinned `spec_revision`.

### Project tasks

A registered project's state directory holds `runtime.db`, the SQLite task store. A state directory with `runtime.db` is SQLite-authoritative for task definitions: `backlog.json` there is a read-only projection, and Markdown files under `backlog/` are not synced into it. Tasks are created and edited through the store, with no Markdown file in any repository:

```bash
orc project task create --feature=app --title="Add login" [--body-file=/any/path.md] [--depends-on=app/setup,app/db] [--priority=high]
orc project task list
orc project task show app/add-login [--revision=1]
orc project task revisions app/add-login
orc project task edit app/add-login --expected-revision=1 [--body-file=...] [--title=...] [--priority=...]
```

All commands accept `--project=<id>`. Every accepted edit creates a new immutable revision with a SHA-256 content hash over its title, body and parsed metadata (title from the first `# ` heading and acceptance criteria from an `Acceptance criteria` checklist unless stated explicitly). `--expected-revision` must name the current revision; a stale value fails instead of overwriting a concurrent edit, and an edit that changes nothing creates no revision. Status is never editable this way. A body that was rendered from fields (no explicit body) is re-rendered when those fields are edited; an explicit body is kept as written. When a run is claimed it is pinned to the task's latest revision, and the worker receives that exact body as its read-only run spec; later edits only affect future runs.

The same API is available as the MCP `create_task`/`update_task`/`get_task` tools (`body_markdown`, `expected_revision`, `spec_revision`) and on the control daemon as `GET /v1/tasks`, `GET /v1/tasks/<ref>`, `GET /v1/tasks/<ref>/revisions`, `POST /v1/tasks` and `POST /v1/tasks/<ref>/revisions` (mutations require the master session credential; a stale `expected_revision` returns `409 conflict`). `orc task-create` creates a database-only task when `ORC_STATE_DIR` is a project state directory.

### Task lifecycle in project SQLite

In a project state directory, task status, attempts, dispatch fields (`owner`, `planning_state`, `delegated_by`, `requeue_eligible_after`) and run bindings live in `runtime.db`, and every status change is an immutable `task_transitions` row naming its cause, run and actor. The scheduler, status views, MCP and CLI read these rows through the `backlog.json` projection; nothing writes status into a Markdown file, and workers never edit a spec's `status:`.

- **Claim** verifies in one transaction that the task is `todo`, that its owner (if any) is the claiming agent, and that every dependency is `done` or `released` in the same project; then it records the `claim` transition and binds the run to the latest revision. If the operational claim cannot be committed afterwards, the task returns to `todo` without counting an attempt.
- **Run start, failure, lease expiry, reset, session reset, unblock and cancel** each update the task status, its run binding and the transition row in one transaction. Execution failures count an attempt and set a requeue backoff; infrastructure failures (dispatch, session start, run-start timeout) do not. A run that ends after an operator already reset or cancelled its task leaves the task alone.
- **Work-complete** changes only the run's finalization state; the task stays `in_progress`. **`done`** is recorded only by the coordinator's merge confirmation (`merge_succeeded`, naming the merged run); a repeated `task-mark-done` or `run-finish` adds nothing, and a worker's `run-finish` before the merge is refused. A task reset after completion can be completed again by its next run.
- **Cancel** (`cancel_task`) moves the task to the terminal `cancelled` status and closes its run as cancelled. Legacy state directories keep their existing behaviour of blocking the task.
- A status change without a lifecycle cause, or a definition change outside a revision, is rejected. A stale Markdown file cannot requeue a completed task: backlog sync is off and ordinary imports never apply status.
- `reconcile` returns a task left `claimed`/`in_progress` without an operational claim to `todo`, and fails an operational claim its `todo`/`blocked` task row does not reflect. A claim whose task is already `done` is in its finalize window and is left to finalization; lease expiry skips it too.

The `events.db` stream still receives the usual lifecycle events after each commit; the authoritative audit record is the transition row written in the same transaction as the status and run change.

### Markdown import and export

Markdown is an explicit, one-way interface to project tasks and plans. Nothing is watched or synced back, and lifecycle status never travels through Markdown.

```bash
orc project task import ~/specs/login.md          # one file; it must be a task spec
orc project task import ~/specs/ [--strict]        # a directory, recursively (skips legacy/)
orc project task export ~/exports/                 # every task as <feature>/<slug>.md
orc project task export ~/login.md --ref=app/login # one task to an exact file
orc project plan import ~/old-orc/plans/3-global-project-state.md
orc project plan export 3 ~/exports/plans/
orc project plan list | show <id>
```

Import reads the spec frontmatter subset (`ref`, `feature`, `title`, `priority`, `required_provider`, `review_level`, `merge_strategy`, `task_type`, `model`, `depends_on`, `required_capabilities`). The title comes from `title:`, else a `# Task N — Title` or first `# ` heading. The body after the frontmatter is stored as the revision body. In a directory, files without a valid `ref` (templates, notes) and anything under `legacy/` are skipped; a named file must be a task spec. A new ref creates revision 1. An existing ref gets a new revision, or nothing when the content is unchanged. Each import records its source path and file hash for diagnostics (`task_imports`).

Lifecycle fields (`status`, `attempt_count`, `blocked_reason`, `owner`, `planning_state`, …) are ignored and reported in `ignored_fields`; `--strict` rejects them instead. An import therefore cannot complete, block, or reopen a task. A file whose `status` is anything other than `todo` cannot create a new task, because it would start as dispatchable work: bring an existing installation's finished and blocked tasks over with `orc project migrate` (below), which carries runtime status, or remove the field to import the spec as new work.

For an existing task the file is the whole definition: an omitted field is cleared (dependencies, review level, provider) rather than kept, and `depends_on: []` is valid. The whole import runs in one transaction, so a file that fails any check leaves the project unchanged. Unlike backlog sync, the title falls back to the first `# ` heading rather than the slug, and duplicate dependencies are merged rather than rejected.

Export writes frontmatter for the definition fields plus `spec_revision` and `content_hash`, followed by the stored body. It never writes `status`. Re-importing an exported file uses its `spec_revision` as the expected revision, so editing a stale export fails with a revision conflict instead of overwriting newer work. Plans are stored whole in `plan_documents` after `parsePlan` validation and export byte-for-byte.

### Migrating an existing installation

`orc project migrate` moves an attached installation (state, specs and plans inside the product repository) or a sibling installation (a separate orchestration home with `target_repo`) into a registered project:

```bash
orc project migrate [legacy-path]                      # dry run: inventory and conflicts, writes nothing
orc project migrate [legacy-path] --execute [--name=N] # back up, import, verify, cut over
orc project migrate [legacy-path] --cleanup-report     # what is left to remove, after the cutover
```

The legacy installation is found from the path (default: the current directory), walking up to the nearest `.orc-state/` or `orc-state.config.json`; from a linked worktree the main checkout's installation is used. The project is registered for the target repository (`target_repo` in a sibling layout, the installation's own repository otherwise).

The dry run reports the layout, tasks by status and definition source, plans, claims and run snapshots, `events.db`/`memory.db` row counts, worktrees, importable and skipped settings, and every issue. **Blocking** issues stop `--execute`: a running legacy coordinator, a `claimed`/`in_progress` task or active claim (let it finish, or end it with `orc run-expire`/`orc task-reset`), duplicate refs, an unparseable spec, `backlog.json`, `claims.json` or database, a task that would fail to import, or a registered project for the same repository that already has its own tasks. **Warnings** are reported and migration continues: a spec whose status disagrees with the runtime, a task without a spec file (its definition is rebuilt from runtime fields), an archived spec under `backlog/legacy/` used for a task still in the runtime, an unknown dependency, an invalid or duplicate plan, and a config key the registry does not accept.

Task status is the **effective runtime status**: `backlog.json`, where a spec status (from the retired status mirror, possibly newer than a stale runtime file) may only make a task less dispatchable: `todo` → `blocked`/`done`/`cancelled`, `blocked` → `done`/`cancelled`. So a finished, blocked or cancelled task is never reopened by a spec that still says `todo`, a completion recorded only in a spec is kept, and a spec that is not in the runtime yet is added with its spec status. Each spec becomes revision 1 of its task (with its import recorded in `task_imports`), keeping the runtime's `created_at`, attempts, block reason and dispatch fields; a non-`todo` status is the task's first `migration_import` transition, which the store allows only once per task, so a replay can never complete a task again. `events.db` and `memory.db` are copied whole, along with `claims.json`, `run-worktrees.json`, `event-checkpoint.json` and run spec snapshots; legacy agent sessions are cleared. Valid plans and settings are imported into project SQLite and the registry.

`--execute` holds the legacy coordinator lock throughout, so a legacy coordinator cannot start mid-migration. A new project is registered with its `migration.json` already present, so it is never active half-imported. The command first copies the legacy state, specs, plans and config into `<state>/migration-backup/<time>/`. It then imports into the project state directory and verifies parity: every task's status, definition hash (title, body, metadata, priority, provider, dependencies), attempts, block reason and dispatch fields; database row counts, claims, run snapshots and plans; that the project's settings are exactly the imported ones; and that the legacy installation did not change since it was inventoried. Only then does it cut over: it writes `.orc-state/project-migration.json`, naming the project, into the legacy state directory, and marks the project's `migration.json` `cut_over`. A failed verification leaves the installation in legacy mode with the mismatches in `migration.json`. Every attempt before the cutover rebuilds the project state, and replaces the settings the previous attempt imported, from the unchanged legacy files, so a retry duplicates nothing; running it after the cutover reports `already_migrated`. `--execute` exits 1 when it is `blocked` or `verification_failed`.

After the cutover, running orc in the legacy root (Git checkout or not), its linked worktrees, or the target repository selects the project, also once `.orc-state/` has been removed (the project's migration record names its source). A legacy override (`ORC_STATE_DIR`, `ORC_HOME`, `ORC_REPO_ROOT`, `ORC_CONFIG_FILE`) that points at the migrated installation, for example in an MCP config written by the legacy `start-session`, selects the project too, so nothing keeps writing to the frozen legacy state. If the registry cannot be opened, the coordinator and `orc doctor` refuse the migrated legacy state directory instead. Nothing is deleted. `--cleanup-report` lists what the project no longer needs, with suggested commands in a safe order (state directory last): legacy run worktrees still registered with Git, `.worktrees/`, `.orc-state/`, `backlog/`, `plans/`, `orc-state.config.json`, `.gitignore` entries, and orchestrator MCP entries in `.mcp.json`/`.codex/config.toml`.

## Environment Variables

### Core Paths

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_STATE_DIR` | Root directory for all state files (backlog.json, agents.json, claims.json, events.db) | `<orchestration-root>/.orc-state` |
| `ORC_HOME` | Force the orchestration root (where state, backlog, plans, and config live). Top precedence for orchestration-root resolution; the coordinator propagates it into a legacy installation's worker sessions so `orc` resolves the orchestration state dir from inside a worktree. | Walk-up to `orc-state.config.json`, else git root |
| `ORC_REPO_ROOT` | Force the repository root path instead of auto-detecting via `git rev-parse`. Also forces the target repo root for git operations of a legacy installation. A forcing/recovery override. | Auto-detected from cwd |
| `ORC_CONFIG_FILE` | Path to the config file | `<orchestration-root>/orc-state.config.json` |
| `ORC_WORKTREES_DIR` | Directory where run worktrees are created | `<orchestration-root>/.worktrees` |
| `ORC_BACKLOG_DIR` | Directory containing backlog task spec markdown files | `<orchestration-root>/backlog` |
| `ORC_PLANS_DIR` | Directory containing plan artifact markdown files | `<orchestration-root>/plans` |
| `ORC_SESSION_TRANSPORT` | Transport for new worker sessions: `auto` (tmux if installed, else node-pty), `tmux` or `pty`. tmux sessions survive a coordinator restart | `auto` |
| `ORC_TMUX_BIN` | tmux binary used by the tmux session transport | `tmux` |
| `ORC_CONTROL_API` | Set to `off` to stop the coordinator serving the local control API (`control.sock`, `control.json`, `control.token` in the state dir). Legacy installations only: a project coordinator refuses to start without it, since its workers report through it | on |
| `ORC_CONTROL_RETRY_MS` | How long a project worker's lifecycle command retries while its coordinator is unreachable (no endpoint, refused connection, or shutting down) | `120000` |

### Worker Pool

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_MAX_WORKERS` | Concurrency limit — maximum number of simultaneously active task-scoped workers | `0` (set via config or CLI) |
| `ORC_WORKER_PROVIDER` | Default provider for task-scoped workers (`claude`, `codex`, or `gemini`); overridden per task by `required_provider` | `codex` (or config `default_provider`) |
| `ORC_WORKER_MODEL` | Model identifier for worker agents | Provider default |
| `ORC_WORKER_EXECUTION_MODE` | Execution mode for worker agents (`full-access` or `sandbox`) | `full-access` |
| `ORC_WORKER_RUNTIME` | Worker runtime (`cli` or `structured`); see [Worker Runtimes](#worker-runtimes) | `cli` |

### Master Agent

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_MASTER_PROVIDER` | Provider for the master agent | `claude` (or config `default_provider`) |
| `ORC_MASTER_MODEL` | Model identifier for the master agent | Provider default |
| `ORC_MASTER_EXECUTION_MODE` | Execution mode for the master agent (`full-access` or `sandbox`) | `full-access` |

### Testing

| Variable | Description |
|----------|-------------|
| `ORC_STRICT_PTY_TESTS` | Set to `1` to fail tests when PTY support is unavailable |
| `ORC_PTY_AVAILABLE` | Set to `1` to skip PTY probe and assume PTY is available |

## Config File

Location: `orc-state.config.json` in the repository root (sibling of `.orc-state/`). Override the path with `ORC_CONFIG_FILE`.

### Full Schema

```json
{
  "default_provider": "claude",
  "default_execution_mode": "full-access",
  "master": {
    "provider": "claude",
    "model": "claude-sonnet-4-20250514",
    "execution_mode": "full-access"
  },
  "worker_pool": {
    "max_workers": 3,
    "provider": "codex",
    "model": "o4-mini",
    "execution_mode": "full-access",
    "runtime": "cli",
    "provider_models": {
      "claude": "claude-sonnet-4-20250514",
      "codex": "o4-mini",
      "gemini": "gemini-2.5-pro"
    }
  },
  "coordinator": {
    "mode": "autonomous",
    "tick_interval_ms": 30000,
    "concurrency_limit": 8,
    "run_start_timeout_ms": 600000,
    "session_ready_timeout_ms": 120000,
    "session_ready_nudge_ms": 15000,
    "session_ready_nudge_interval_ms": 30000,
    "run_inactive_timeout_ms": 1800000,
    "run_inactive_nudge_ms": 600000,
    "run_inactive_escalate_ms": 900000,
    "run_inactive_nudge_interval_ms": 300000,
    "session_start_max_attempts": 3,
    "session_start_retry_delay_ms": 30000,
    "worker_stale_soft_ms": 1800000,
    "worker_stale_nudge_ms": 3600000,
    "worker_stale_force_fail_ms": 7200000
  },
  "leases": {
    "default_ms": 1800000,
    "finalize_ms": 3600000
  }
}
```

All fields are optional. Omitted fields use their defaults.

> **Note:** Model names in examples (e.g., `claude-sonnet-4-20250514`) reflect
> models available at time of writing and may change. Check your provider's
> documentation for current model identifiers.

### `default_provider`

Sets the fallback provider for both master and worker pool when neither a section-specific provider nor an environment variable is set. Must be `claude`, `codex`, or `gemini`.

> The master defaults to `claude` (optimized for interactive conversation)
> while workers default to `codex` (optimized for autonomous coding). Override
> both via config file or environment variables.

### `default_execution_mode`

Sets the fallback execution mode for both master and worker pool when neither a section-specific `execution_mode` nor an environment variable is set. Must be `full-access` or `sandbox`. Defaults to `full-access`.

### `target_repo` (retired)

The sibling layout this key enabled is retired. A legacy config that still
names a separate `target_repo` is refused by `orc start-session`, the
coordinator and the MCP server, and reported by `orc doctor`/`orc preflight`;
migrate it with `orc project migrate <orchestration-home> --execute`, which
registers the target repository as a project. See
[Sibling Mode](./sibling-mode.md).

### `master`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"claude"` | Provider for the master agent |
| `model` | string | `null` | Model override for the master agent |
| `execution_mode` | string | `"full-access"` | Execution mode for the master agent (`full-access` or `sandbox`) |

### `worker_pool`

Workers are spawned on demand at dispatch time — `max_workers` is a concurrency limit, not
a count of pre-created agents. No idle worker agents exist between tasks; available capacity
equals `max_workers` minus the number of workers currently registered. The provider for each
worker is resolved at dispatch time from the task's `required_provider` field when set,
otherwise from `worker_pool.provider` (or `ORC_WORKER_PROVIDER`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_workers` | integer | `0` | Concurrency limit — maximum number of task-scoped workers that may run simultaneously. Workers are spawned on demand up to this limit and removed after completion. Default: `0`. `orc init` generates a config with `max_workers: 1` for immediate usability. |
| `provider` | string | `"codex"` | Default provider for task-scoped workers. Overridden per task by the task's `required_provider` field. |
| `model` | string | `null` | Default model for all workers |
| `execution_mode` | string | `"full-access"` | Execution mode for worker agents (`full-access` or `sandbox`) |
| `runtime` | string | `"cli"` | `cli` drives the provider's terminal UI; `structured` uses a proven structured protocol where one exists. See [Worker Runtimes](#worker-runtimes). |
| `provider_models` | object | `{}` | Per-provider model overrides (keyed by provider name) |

When a worker is launched, its model is resolved as: `provider_models[provider]` first, then `model`, then provider default.

### `coordinator`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `"autonomous"` | Coordinator mode |
| `tick_interval_ms` | integer | `30000` | Interval between coordinator ticks (ms) |
| `concurrency_limit` | integer | `8` | Max concurrent dispatched runs |
| `run_start_timeout_ms` | integer | `600000` | Time before a dispatched run that hasn't started is considered failed (ms) |
| `session_ready_timeout_ms` | integer | `120000` | Time to wait for a worker session to become ready (ms) |
| `session_ready_nudge_ms` | integer | `15000` | Delay before first nudge to an unready session (ms) |
| `session_ready_nudge_interval_ms` | integer | `30000` | Interval between session-ready nudges (ms) |
| `run_inactive_timeout_ms` | integer | `1800000` | Time before an inactive run is timed out (ms) |
| `run_inactive_nudge_ms` | integer | `600000` | Delay before first nudge to an inactive run (ms) |
| `run_inactive_escalate_ms` | integer | `900000` | Delay before escalating an inactive run (ms) |
| `run_inactive_nudge_interval_ms` | integer | `300000` | Interval between inactivity nudges (ms) |
| `session_start_max_attempts` | integer | `3` | Max retry attempts for starting a worker session |
| `session_start_retry_delay_ms` | integer | `30000` | Delay between session start retries (ms) |
| `memory_prune_interval_ms` | integer | `3600000` | Interval between periodic memory pruning runs (ms). Set to `0` to disable periodic pruning (startup prune still runs). Note: `0` can only be set via config file — the CLI flag does not accept zero. |
| `worker_stale_soft_ms` | integer | `1800000` | Inactivity before soft alert — emits `worker_needs_attention` notification (30 min). |
| `worker_stale_nudge_ms` | integer | `3600000` | Inactivity before PTY nudge message (60 min). |
| `worker_stale_force_fail_ms` | integer | `7200000` | Inactivity before force-fail with `policy: requeue` (2 hours). |
| `merge_strategy` | string | `"direct"` | `"direct"` for worktree merge, `"pr"` for pull request. |
| `pr_provider` | string\|null | `null` | Git host provider (`"github"`). Required when `merge_strategy` is `"pr"`. |
| `pr_push_remote` | string | `"origin"` | Git remote to push PR branches to. |
| `pr_finalize_lease_ms` | integer | `86400000` | Claim lease duration for PR finalization (24h). |

All `coordinator` fields can also be passed as CLI flags to `coordinator.ts` (e.g., `--tick-interval-ms=10000`). CLI flags override config file values.

### `leases`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_ms` | integer | `1800000` (30 min) | Default claim lease duration |
| `finalize_ms` | integer | `3600000` (60 min) | Extended lease for the finalize phase |

## Worker Runtimes

`worker_pool.runtime` (or `ORC_WORKER_RUNTIME`) selects how task workers talk to
their provider. Any other value is rejected at config load.

| Runtime | Behaviour |
|---------|-----------|
| `cli` (default) | The provider's interactive CLI runs in a terminal (PTY or tmux). Input is typed text with no acknowledgement from the provider. |
| `structured` | Codex runs as `codex app-server --listen stdio://` (session handle `app:<agent_id>`). Other providers have no proven structured protocol, so they stay on the CLI and record `provider_ref.runtime_fallback` with the reason. |

On the Codex app-server runtime:

- **Subscription only.** API-key variables (`OPENAI_API_KEY`, `CODEX_API_KEY`, …)
  are removed from the provider environment, and `account/read` must report a
  ChatGPT login before a thread starts. Any other account fails the launch with
  `unverified_auth`; it never falls back to API billing.
- **Durable, acknowledged input.** Every coordinator message (task envelope,
  nudges, follow-ups) is a durable command. It is `accepted` when the
  provider answers `turn/start`, `running` when the turn starts, and
  `completed`/`failed` when the turn ends. The task envelope is keyed per run,
  so a retried dispatch does not resend it.
- **Turn-based delivery.** Input reaches the provider only between turns. A
  message for a worker whose turn is still running (e.g. a finalize notice or
  `PR_REVIEW` right after `run-work-complete`) waits in the queue without using
  an attempt and goes out when the turn ends. Nudges are skipped for a worker
  that is mid-turn. The worker bootstrap tells the agent to end its turn after
  `run-work-complete` rather than wait inside it. The `FINALIZE_SUCCESS` notice
  is not delivered: the coordinator has already finished the run and cleans the
  session up.
- **Readiness.** The protocol handshake marks the session ready, so no
  `report-for-duty` turn is needed.
- **Declared capabilities.** The session supports structured events, command
  ACK and thread resume. Resume is adapter-level (`resume_thread_id`); the
  coordinator does not yet resume threads after a restart. Steering, interrupt
  and approvals are not proven, so
  they are refused with a typed `unsupported_capability` error: input sent
  while a turn runs is refused rather than queued into it, and provider
  approval requests are declined (threads run with `approvalPolicy: never`).
- **Process ownership.** The app-server's stdio belongs to the coordinator
  that launched it, and the session ends with that coordinator; the run is then
  requeued by the normal liveness path. Other processes see the session through
  its recorded PID and start time: alive but not writable (`recoverable` after a
  coordinator restart), and `orc worker-remove` stops it by signal.

To roll back, set `runtime` to `cli`. Run history and command records are kept;
a command whose delivery could not be confirmed stays `outcome_unknown` until
an operator resolves it.

## Execution Modes

Execution modes control the trust level and sandbox behaviour of agent processes. Two presets are available.

### Presets

| Preset | Description |
|--------|-------------|
| `full-access` | Agent process runs with full filesystem and network access. No sandbox is applied. This is the default and preserves backward compatibility. |
| `sandbox` | Agent process is confined to the workspace. File writes outside the working directory are blocked and unsandboxed shell commands are disallowed. |

`full-access` is the default for all roles. Switching to `sandbox` provides defence-in-depth for untrusted or experimental agents at the cost of some operational flexibility.

### Config Fields

Execution mode can be set at three levels of specificity (most-specific wins):

| Level | Config field / env var | Applies to |
|-------|------------------------|------------|
| Top-level default | `default_execution_mode` | Both master and worker pool (fallback) |
| Master section | `master.execution_mode` | Master agent only |
| Worker pool section | `worker_pool.execution_mode` | Worker agents only |

```json
{
  "default_execution_mode": "sandbox",
  "master": {
    "execution_mode": "full-access"
  },
  "worker_pool": {
    "execution_mode": "sandbox"
  }
}
```

### Environment Variable Overrides

| Variable | Overrides | Description |
|----------|-----------|-------------|
| `ORC_MASTER_EXECUTION_MODE` | `master.execution_mode` | Execution mode for the master agent |
| `ORC_WORKER_EXECUTION_MODE` | `worker_pool.execution_mode` | Execution mode for worker agents |

Environment variables take precedence over all config file values (see [Resolution Order](#resolution-order)).

### Per-Provider Behaviour

The flags passed to each provider CLI differ by preset:

#### Claude (`claude`)

| Preset | Flags passed |
|--------|-------------|
| `full-access` | `--dangerously-skip-permissions` |
| `sandbox` | `--permission-mode auto` |

Task workers launch with their assigned worktree as the working directory (task 204). Scouts launch in their linked worktree or the orchestration root.

In `sandbox` mode, a Claude settings file is also written that sets `allowUnsandboxedCommands: false` and restricts filesystem writes to an explicit list (`allowWrite`):

- `.` — the launch working directory, i.e. the assigned worktree.
- in a legacy installation, the state directory (`.orc-state/`): its `orc` lifecycle commands (`run-start`, `progress`, `run-work-complete`, `review-submit`, `memory-record`, …) write the event log, claims, and memory store there from the worker's own session. A project worker gets the control socket instead, never its state directory: the coordinator applies its lifecycle commands (see **Global project registry**).
- the `.git` subtrees a worktree commit/rebase/fetch writes — `objects/`, `refs/`, `logs/`, and `worktrees/` — of the repo that backs the worktree: the installation's own repository in a legacy attached installation, the registered target repository for a project. A linked worktree shares its main repo's object store, refs and per-worktree state, all of which lie outside the worktree directory.

Any of these that already lies inside the launch directory is omitted. The `.git` grant is scoped to those subtrees rather than the whole `.git` directory on purpose: `.git/hooks` and `.git/config` are **excluded**, so a sandboxed worker cannot plant a hook script or rewrite git config that the unsandboxed coordinator would later execute during a merge, push, or worktree operation. The rest of the orchestration root (main checkout, `backlog/`, `plans/`) is not writable. Workers never edit a task spec's `status:`; task status is runtime-owned. In a legacy installation the sandbox does not isolate the worker from state it legitimately writes through the CLI; in a project it can change only its own run, through the coordinator.

#### Codex (`codex`)

| Preset | Flags passed |
|--------|-------------|
| `full-access` | `--dangerously-bypass-approvals-and-sandbox` |
| `sandbox` | `--sandbox workspace-write --ask-for-approval never` |

`workspace-write` covers the launch directory (the assigned worktree). Codex sandbox mode additionally passes a config override granting the same extra roots as Claude — the state directory (the control socket for a project worker) and the backing repo's `.git` subtrees (`objects/`, `refs/`, `logs/`, `worktrees/`) — with the same `hooks/` + `config` exclusion. The value is JSON-encoded so paths with special characters stay well-formed:

```
-c sandbox_workspace_write.writable_roots=["<state-dir>","<repo>/.git/objects","<repo>/.git/refs","<repo>/.git/logs","<repo>/.git/worktrees"]
```

> **Note:** this `writable_roots` override form is documented but was not verifiable against a live Codex CLI at the time it shipped (the CLI binary was unavailable in the build environment). If Codex sandbox commits or `orc` calls fail, verify the current `writable_roots` config key against your installed `codex` version and adjust `codexSandboxWritableRootArgs` in `adapters/pty.ts`.

#### Gemini (`gemini`)

Gemini does not have a sandbox CLI flag. The `execution_mode` field is accepted and stored, but no extra flags are passed at either preset level.

### Scout Override

Scouts are launched with `read_only: true`, which tightens their permissions when `execution_mode` is `sandbox`:

- For Codex sandbox: the sandbox scope is `read-only` instead of `workspace-write`.
- For Claude sandbox: filesystem writes are blocked entirely (no `allowWrite` entry in the settings file).

When `execution_mode` is `full-access`, `read_only` has no effect — a scout receives the same flags as a regular worker (`--dangerously-bypass-approvals-and-sandbox` for Codex, `--dangerously-skip-permissions` for Claude). To enforce read-only scout behaviour, set `execution_mode` to `sandbox`.

### Linux Prerequisites for Claude Sandbox Mode

On Linux, Claude sandbox mode relies on [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) and `socat`. On macOS, Seatbelt is used instead and no additional packages are needed.

Install the required packages before enabling `sandbox` mode with a Claude provider on Linux:

```bash
# Ubuntu / Debian
sudo apt-get install bubblewrap socat

# Fedora
sudo dnf install bubblewrap socat
```

Run `orc doctor` to verify the dependencies are present:

```bash
orc doctor
# sandbox dependencies: ok=true
```

If the binaries are missing, `orc doctor` lists them and prints the install commands above.

### Example Configurations

**All agents sandboxed (recommended for production):**

```json
{
  "default_execution_mode": "sandbox"
}
```

**Master full-access, workers sandboxed (mixed trust):**

```json
{
  "master": {
    "execution_mode": "full-access"
  },
  "worker_pool": {
    "execution_mode": "sandbox"
  }
}
```

**Override via environment variable (e.g. CI):**

```bash
export ORC_WORKER_EXECUTION_MODE=sandbox
orc start-session
```

## Resolution Order

For any setting that can be specified in multiple places, the precedence is:

1. CLI flag (highest)
2. Environment variable
3. Config file section-specific value
4. Config file `default_provider` / `default_execution_mode` (for provider and execution mode fields)
5. Built-in default (lowest)

## State Directory Layout

The state directory (default `.orc-state/`) contains:

```
.orc-state/
  backlog.json          # Task definitions and statuses
  agents.json           # Registered agent records
  claims.json           # Active and recent claim records
  events.db             # SQLite event store
  run-worktrees.json    # Mapping of run IDs to worktree paths
  pty-hook-events/      # Per-agent NDJSON hook event files
```

These files are managed exclusively by `orc` CLI commands and the coordinator. Do not edit them directly.

## Minimal Setup

The simplest way to get started:

```bash
export ORC_MAX_WORKERS=2
export ORC_WORKER_PROVIDER=claude
orc start-session
```

Or equivalently with a config file:

```json
{
  "default_provider": "claude",
  "worker_pool": {
    "max_workers": 2
  }
}
```

## See also

- [Getting started](./getting-started.md)
- [CLI reference](./cli.md)
- [Contracts & invariants](./contracts.md)
