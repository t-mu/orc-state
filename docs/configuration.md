# Configuration

orc-state is configured through project settings in the global registry (`orc project config`) and environment variables. Environment variables take precedence over stored settings.

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

Project lookup uses `--project`, then `ORC_PROJECT_ID`, then the current repository's canonical Git root, then the selected project only outside a Git repository. An unknown or ambiguous match is an error. Settings are validated against known non-secret config keys. Effective values resolve from CLI overrides, environment, project settings, then global settings. `project config list` shows effective values; `--global` shows stored global values. Commands run against a registered project as described below; a repository that still has a legacy layout must be migrated first.

### Running against a registered project

An orc command runs in **project mode** when `ORC_PROJECT_ID` names a registered project. Otherwise, when no legacy override (`ORC_STATE_DIR`, `ORC_HOME`, `ORC_REPO_ROOT`, `ORC_CONFIG_FILE`) is set, the current directory's canonical Git root selects its registered project (a root registered twice is an error), and outside every Git repository the project chosen with `orc project select` applies. A repository that still has a legacy `.orc-state/` or `orc-state.config.json` (between the current directory and its Git root) selects no project until it is migrated, and a legacy installation no longer runs (see **Legacy installations** below); once `orc project migrate` cuts it over, that layout, or a legacy override naming it, selects its project instead. `ORC_PROJECT_ID` overrides both. A project whose migration has not been cut over is not active yet, and naming the project explicitly is an error. Each project state directory holds a `project.json` descriptor (id, name, target root), so a worker given `ORC_PROJECT_ID` and its state directory resolves the project without opening the global registry.

In project mode:

- State, run worktrees (`<state>/worktrees/<run_id>`), PTY logs, provider settings, plans and exports live under the project's state directory in the data home. Git operations (worktrees, branches, merges) run against the registered target repository; only Git's own worktree metadata lands in the target's `.git`.
- Settings come from the registry (`orc project config`), project over global, with environment and CLI overrides on top. No `orc-state.config.json` is read or needed.
- Workers receive `ORC_PROJECT_ID`, their session id as `ORC_SESSION_ID` (it names the session, e.g. in `report-for-duty`; not a credential, and an inherited legacy `ORC_SESSION_TOKEN` is blanked), their session secret as `ORC_SESSION_SECRET` (their actor credential, task 231), and the control socket as `ORC_CONTROL_SOCKET`, which `orc control` and the worker lifecycle commands use in place of the recorded endpoint path; the daemon's bearer token is still read from `<state>/control.token`. `ORC_STATE_DIR` is still set as a temporary bridge, and `ORC_HOME`/`ORC_REPO_ROOT`/`ORC_CONFIG_FILE` are blanked (a blank value counts as unset) so an inherited legacy value cannot redirect them. A sandboxed worker that cannot open the registry runs on environment settings and defaults.
- Worker lifecycle commands — `run-start`, `progress`, `run-work-complete`, `run-fail`, `run-finish`, `run-input-request`, `review-submit`, `memory-record` and `report-for-duty` — do not write the state directory in a project. Each is sent to the coordinator over `ORC_CONTROL_SOCKET` with the session secret, and the coordinator applies it, so no worker process writes `runtime.db`, `events.db` or `claims.json`. The credential must be a session that is not `offline` (`running`, `recoverable` or `unknown` — after a coordinator restart the session secret, not the process identity, is what proves the caller) launched for the named run (and agent); an `offline` session may still poll its own input request and repeat `run-finish` on a run that is already `done`, everything else is refused with `401`; `--agent-id` alone is not trusted, and a request for another run is refused with `403 forbidden`. Each launched session — worker, scout and master — gets a random secret that only its own process holds: it is passed in the environment, never written to the state directory, PTY logs, the bootstrap or events, and the `sessions` table keeps only its SHA-256 hash. A session id read from the state directory therefore authenticates nobody. The secret is only as private as the sandbox: a `full-access` worker runs as the same user and can read other processes' environments (`/proc/<pid>/environ`), and so can a worker in a sandbox without its own process namespace, such as Codex's; `worker_pool.sandbox_network: open` also lets a sandboxed worker reach other local sockets. The guarantee assumes a sandboxed worker with the default `restricted` network. Upgrading a project with runs in flight: workers launched before session secrets hold none, so their lifecycle commands fail with `ORC_SESSION_SECRET is not set`; drain or reset those tasks (`orc task-reset <ref>`) when upgrading. Without `ORC_SESSION_SECRET` these commands fail, except `memory-record`, which an operator shell still writes directly. While the coordinator is stopped or restarting a command retries for up to two minutes (`ORC_CONTROL_RETRY_MS`), and only when the request never reached it. A project coordinator therefore requires the control API: it refuses to start with `ORC_CONTROL_API=off` or when the socket cannot be served.
- Master and operator mutations — MCP `cancel_task`, `reset_task`, `unblock_task`, `delegate_task`, `respond_input`, and `orc task-cancel`, `task-reset`, `task-unblock`, `delegate`, `run-input-respond` — are applied by the coordinator too (`POST /v1/operator`), under their own rule: a session credential must be the master's (not `offline`), which `orc start-session` puts in the master provider's environment as `ORC_MASTER_SECRET` (its MCP config only references it: `${ORC_MASTER_SECRET}` for Claude and Gemini, `env_vars` for Codex), so the master's tools and the commands its shell runs act as the master. An MCP server without that secret (for example one a repository's `.mcp.json` starts for an editor session) refuses every write tool and points at the orc CLI; its read tools still work. A shell inside a worker session presents its own `ORC_SESSION_SECRET` and is refused with `403`; in a project the master's tools always act as the master (`actor_id` is ignored), and `respond_input` needs `ORC_MASTER_SECRET`. A shell without a session acts as the operator by presenting the operator token the coordinator writes to `<state>/operator.token` on every start (sandboxed Claude sessions are denied reading it, by the sandbox and by a permission rule for the Read tool; a Codex sandbox cannot deny reads, which matters only where a sandboxed Codex worker can reach the socket at all, i.e. with `sandbox_network: open`, or for `full-access` workers of any provider), and is recorded as `human` or a registered agent named with `--actor-id`. Answering an input request (`run-input-respond`) needs the master's credential in every case. With no coordinator running these commands — and the master's tools — write the state directly under the state lock, after the same authorization (a worker session is still refused), and print `coordinator is not running; applying <op> directly`; that is the documented recovery path. The master's session row is closed when `orc start-session`'s master exits or `start-session` receives SIGHUP or SIGTERM; only a SIGKILL leaves it open until the next `start-session`, and the secret it would need lives only in that master's process tree.
- Sandboxed project workers may write their worktree, the target's `.git` object, ref and worktree-metadata subtrees, and the control socket — never the project state directory or the target working tree. Claude, Codex, and the Codex app-server runtime get the same writable roots. Reaching the socket is a network permission: only Claude's macOS sandbox allows that one path; Codex and Claude on Linux connect only with the opt-in `worker_pool.sandbox_network: open`, which widens the sandbox network (see **Execution Modes**), and `orc doctor` and the coordinator's startup log warn when the default worker provider could not connect. Read commands a worker runs ask the running coordinator: `review-read` and `memory-wake-up` use the control API (`GET /v1/runs/<run_id>/reviews`, `GET /v1/memory/wake-up`). When no coordinator answers they, like `status`, `runs-active` and `run-info`, read the state directory directly; a worker session (one with `ORC_SESSION_SECRET`) that cannot write it opens the databases read-only. That works while another process holds the database's WAL files open; with every process closed, a sandboxed read fails — `review-read` and `memory-wake-up` exit 1 asking to retry once the coordinator is running. Writer processes (the coordinator, the MCP server, operator shells) never fall back to read-only.

### Legacy installations

An installation that keeps `.orc-state/`, `backlog/` and `orc-state.config.json` inside its repository (attached), or a separate orchestration home with `target_repo` (sibling), no longer runs. Without a registered project, `orc init`, `orc start-session`, the coordinator and the MCP server refuse to start, and `orc doctor` and `orc preflight` fail (exit 1); each points at `orc project migrate <root> --execute` (see **Migrating an existing installation**) or `orc project add <git-path>`. Nothing reads `backlog/` specs any more, except the migration itself.

### Selecting and switching projects

Every `orc` command accepts `--project=<id>` (or `--project <id>`), before or after the subcommand; it is the highest-precedence selector and an unknown id is an error. Inside a registered repository the repository selects its project; outside every repository `orc project select <id>` sets the default. Switching changes only the registry selection or the flag — no repository file is written, and provider logins are untouched because they live in the providers' own stores.

`orc status`, `orc watch` (TUI header), `orc doctor` and `orc preflight` print the active project (`project: <name> (<id>) → <target root>`; JSON output carries a `project` object). In project mode `doctor` and `preflight` check the target repository, the state directory, the project task store, and warn about orc artifacts left in the target working tree. `orc start-session` passes the project identity to the coordinator and the master's MCP server; a Codex master receives its MCP server as `-c` overrides, so nothing is written into the repository. The control API snapshot carries the project identity, and each run row its task's SQLite `task_status` and pinned `spec_revision`.

### Project tasks

A registered project's state directory holds `runtime.db`, the SQLite task store. A state directory with `runtime.db` is SQLite-authoritative for task definitions: `backlog.json` there is a read-only projection, and no Markdown file is synced into it. Tasks are created and edited through the store, with no Markdown file in any repository:

```bash
orc project task create --feature=app --title="Add login" [--body-file=/any/path.md] [--depends-on=app/setup,app/db] [--priority=high]
orc project task list
orc project task show app/add-login [--revision=1]
orc project task revisions app/add-login
orc project task edit app/add-login --expected-revision=1 [--body-file=...] [--title=...] [--priority=...]
```

All commands accept `--project=<id>`. Every accepted edit creates a new immutable revision with a SHA-256 content hash over its title, body and parsed metadata (title from the first `# ` heading and acceptance criteria from an `Acceptance criteria` checklist unless stated explicitly). `--expected-revision` must name the current revision; a stale value fails instead of overwriting a concurrent edit, and an edit that changes nothing creates no revision. Status is never editable this way. A body that was rendered from fields (no explicit body) is re-rendered when those fields are edited; an explicit body is kept as written. When a run is claimed it is pinned to the task's latest revision, and the worker receives that exact body as its read-only run spec; later edits only affect future runs.

The same API is available as the MCP `create_task`/`update_task`/`get_task` tools (`body_markdown`, `expected_revision`, `spec_revision`) and on the control daemon as `GET /v1/tasks`, `GET /v1/tasks/<ref>`, `GET /v1/tasks/<ref>/revisions`, `POST /v1/tasks` and `POST /v1/tasks/<ref>/revisions` (mutations require the master session credential; a stale `expected_revision` returns `409 conflict`).

### Task lifecycle in project SQLite

In a project state directory, task status, attempts, dispatch fields (`owner`, `planning_state`, `delegated_by`, `requeue_eligible_after`) and run bindings live in `runtime.db`, and every status change is an immutable `task_transitions` row naming its cause, run and actor. The scheduler, status views, MCP and CLI read these rows through the `backlog.json` projection; nothing writes status into a Markdown file, and workers never edit a spec's `status:`.

- **Claim** verifies in one transaction that the task is `todo`, that its owner (if any) is the claiming agent, and that every dependency is `done` or `released` in the same project; then it records the `claim` transition and binds the run to the latest revision. If the operational claim cannot be committed afterwards, the task returns to `todo` without counting an attempt.
- **Run start, failure, lease expiry, reset, session reset, unblock and cancel** each update the task status, its run binding and the transition row in one transaction. Execution failures count an attempt and set a requeue backoff; infrastructure failures (dispatch, session start, run-start timeout) do not. A run that ends after an operator already reset or cancelled its task leaves the task alone.
- **Work-complete** changes only the run's finalization state; the task stays `in_progress`. **`done`** is recorded only by the coordinator's merge confirmation (`merge_succeeded`, naming the merged run); a repeated `task-mark-done` or `run-finish` adds nothing, and a worker's `run-finish` before the merge is refused. A task reset after completion can be completed again by its next run.
- **Cancel** (`cancel_task`) moves the task to the terminal `cancelled` status and closes its run as cancelled.
- A status change without a lifecycle cause, or a definition change outside a revision, is rejected. A stale Markdown file cannot requeue a completed task: nothing syncs Markdown and ordinary imports never apply status.
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

For an existing task the file is the whole definition: an omitted field is cleared (dependencies, review level, provider) rather than kept, and `depends_on: []` is valid. The whole import runs in one transaction, so a file that fails any check leaves the project unchanged. Unlike the retired backlog sync, the title falls back to the first `# ` heading rather than the slug, and duplicate dependencies are merged rather than rejected.

Export writes frontmatter for the definition fields plus `spec_revision` and `content_hash`, followed by the stored body. It never writes `status`. Re-importing an exported file uses its `spec_revision` as the expected revision, so editing a stale export fails with a revision conflict instead of overwriting newer work. Plans are stored whole in `plan_documents` after `parsePlan` validation and export byte-for-byte.

### Migrating an existing installation

`orc project migrate` moves an attached installation (state, specs and plans inside the product repository) or a sibling installation (a separate orchestration home with `target_repo`) into a registered project. It is the only way to keep using such an installation, which no longer runs (see **Legacy installations**):

```bash
orc project migrate [legacy-path]                      # dry run: inventory and conflicts, writes nothing
orc project migrate [legacy-path] --execute [--name=N] # back up, import, verify, cut over
orc project migrate [legacy-path] --cleanup-report     # what is left to remove, after the cutover
```

The legacy installation is found from the path (default: the current directory), walking up to the nearest `.orc-state/` or `orc-state.config.json`; from a linked worktree the main checkout's installation is used. The project is registered for the target repository (`target_repo` in a sibling layout, the installation's own repository otherwise).

The dry run reports the layout, tasks by status and definition source, plans, claims and run snapshots, `events.db`/`memory.db` row counts, worktrees, importable and skipped settings, and every issue. **Blocking** issues stop `--execute`: a running legacy coordinator, a `claimed`/`in_progress` task or active claim (let it finish, or end it with `orc run-expire`/`orc task-reset`), duplicate refs, an unparseable spec, `backlog.json`, `claims.json` or database, a task that would fail to import, or a registered project for the same repository that already has its own tasks. **Warnings** are reported and migration continues: a spec whose status disagrees with the runtime, a task without a spec file (its definition is rebuilt from runtime fields), an archived spec under `backlog/legacy/` used for a task still in the runtime, an unknown dependency, an invalid or duplicate plan, and a config key the registry does not accept.

Task status is the **effective runtime status**: `backlog.json`, where a spec status (from the retired status mirror, possibly newer than a stale runtime file) may only make a task less dispatchable: `todo` → `blocked`/`done`/`cancelled`, `blocked` → `done`/`cancelled`. So a finished, blocked or cancelled task is never reopened by a spec that still says `todo`, a completion recorded only in a spec is kept, and a spec that is not in the runtime yet is added with its spec status. Each spec becomes revision 1 of its task (with its import recorded in `task_imports`), keeping the runtime's `created_at`, attempts, block reason and dispatch fields; a non-`todo` status is the task's first `migration_import` transition, which the store allows only once per task, so a replay can never complete a task again. `events.db` and `memory.db` are copied whole, along with `claims.json`, `run-worktrees.json`, `event-checkpoint.json` and run spec snapshots; legacy agent sessions are cleared. Valid plans and settings are imported into project SQLite and the registry.

`--execute` holds the legacy coordinator lock throughout, so a coordinator of an older orc version cannot start on the installation mid-migration. A new project is registered with its `migration.json` already present, so it is never active half-imported. The command first copies the legacy state, specs, plans and config into `<state>/migration-backup/<time>/`. It then imports into the project state directory and verifies parity: every task's status, definition hash (title, body, metadata, priority, provider, dependencies), attempts, block reason and dispatch fields; database row counts, claims, run snapshots and plans; that the project's settings are exactly the imported ones; and that the legacy installation did not change since it was inventoried. Only then does it cut over: it writes `.orc-state/project-migration.json`, naming the project, into the legacy state directory, and marks the project's `migration.json` `cut_over`. A failed verification leaves the installation unmigrated with the mismatches in `migration.json`. Every attempt before the cutover rebuilds the project state, and replaces the settings the previous attempt imported, from the unchanged legacy files, so a retry duplicates nothing; running it after the cutover reports `already_migrated`. `--execute` exits 1 when it is `blocked` or `verification_failed`.

After the cutover, running orc in the legacy root (Git checkout or not), its linked worktrees, or the target repository selects the project, also once `.orc-state/` has been removed (the project's migration record names its source). A legacy override (`ORC_STATE_DIR`, `ORC_HOME`, `ORC_REPO_ROOT`, `ORC_CONFIG_FILE`) that points at the migrated installation, for example in an MCP config written by the legacy `start-session`, selects the project too, so nothing keeps writing to the frozen legacy state. If the registry cannot be opened, the coordinator and `orc doctor` refuse the migrated legacy state directory instead. Nothing is deleted. `--cleanup-report` lists what the project no longer needs, with suggested commands in a safe order (state directory last): legacy run worktrees still registered with Git, `.worktrees/`, `.orc-state/`, `backlog/`, `plans/`, `orc-state.config.json`, `.gitignore` entries, and orchestrator MCP entries in `.mcp.json`/`.codex/config.toml`.

## Environment Variables

### Core Paths

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_DATA_HOME` | Directory of the global `registry.db` and the `projects/<id>` state directories | Platform data directory (see above) |
| `ORC_PROJECT_ID` | Select a registered project (set by `--project` and for launched sessions) | — |
| `ORC_STATE_DIR` | Set for launched sessions as a bridge to their project state directory. Otherwise a legacy path override: naming a migrated installation's state directory selects its project; naming an unmigrated one selects no project | The project state directory |
| `ORC_HOME`, `ORC_REPO_ROOT`, `ORC_CONFIG_FILE` | Legacy path overrides (blanked for launched sessions). One naming a migrated installation selects its project; otherwise no project is selected, and a legacy installation no longer runs | — |
| `ORC_WORKTREES_DIR` | Directory where run worktrees are created | `<state>/worktrees` |
| `ORC_SESSION_TRANSPORT` | Transport for new worker sessions: `auto` (tmux if installed, else node-pty), `tmux` or `pty`. tmux sessions survive a coordinator restart | `auto` |
| `ORC_TMUX_BIN` | tmux binary used by the tmux session transport | `tmux` |
| `ORC_CONTROL_API` | The coordinator serves the local control API (`control.sock`, `control.json`, `control.token` in the state dir). A project coordinator refuses to start with `off`, since its workers report through it | on |
| `ORC_CONTROL_RETRY_MS` | How long a project worker's lifecycle command retries while its coordinator is unreachable (no endpoint, refused connection, or shutting down) | `120000` |

### Worker Pool

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_MAX_WORKERS` | Concurrency limit — maximum number of simultaneously active task-scoped workers | `0` (set via config or CLI) |
| `ORC_WORKER_PROVIDER` | Default provider for task-scoped workers (`claude`, `codex`, or `gemini`); overridden per task by `required_provider` | `codex` (or config `default_provider`) |
| `ORC_WORKER_MODEL` | Model identifier for worker agents | Provider default |
| `ORC_WORKER_EXECUTION_MODE` | Execution mode for worker agents (`full-access` or `sandbox`) | `full-access` |
| `ORC_WORKER_RUNTIME` | Worker runtime (`cli` or `structured`); see [Worker Runtimes](#worker-runtimes) | `cli` |
| `ORC_WORKER_SANDBOX_NETWORK` | Network a sandboxed project worker gets for its control socket (`restricted` or `open`); see [Execution Modes](#execution-modes) | `restricted` |

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

A project has no config file: its settings are stored in the registry, project over global, with dotted keys for nested fields (`orc project config set worker_pool.max_workers 2`). The schema below shows the settings as the nested object the loaders see; `orc init` records `default_provider`, `worker_pool.provider` and `worker_pool.max_workers`.

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
> both via project settings or environment variables.

### `default_execution_mode`

Sets the fallback execution mode for both master and worker pool when neither a section-specific `execution_mode` nor an environment variable is set. Must be `full-access` or `sandbox`. Defaults to `full-access`.

### `target_repo` (retired)

The sibling layout this key enabled is retired. A legacy config that still
names a separate `target_repo` is refused by `orc init`, `orc start-session`,
the coordinator and the MCP server, and fails `orc doctor`/`orc preflight`;
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
| `max_workers` | integer | `0` | Concurrency limit — maximum number of task-scoped workers that may run simultaneously. Workers are spawned on demand up to this limit and removed after completion. Default: `0`. `orc init` sets `worker_pool.max_workers` to `1` when it is unset, for immediate usability. |
| `provider` | string | `"codex"` | Default provider for task-scoped workers. Overridden per task by the task's `required_provider` field. |
| `model` | string | `null` | Default model for all workers |
| `execution_mode` | string | `"full-access"` | Execution mode for worker agents (`full-access` or `sandbox`) |
| `runtime` | string | `"cli"` | `cli` drives the provider's terminal UI; `structured` uses a proven structured protocol where one exists. See [Worker Runtimes](#worker-runtimes). |
| `sandbox_network` | string | `"restricted"` | In `sandbox` mode, how a project worker or scout may reach its coordinator's control socket. `restricted` allows only that socket's path, which only Claude's macOS sandbox honours. `open` lets Claude on Linux connect to every Unix socket and gives Codex workers network access (a read-only Codex scout has no network setting). `orc doctor` and the coordinator warn when the default worker provider could not connect. See [Execution Modes](#execution-modes). |
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
| `memory_prune_interval_ms` | integer | `3600000` | Interval between periodic memory pruning runs (ms). Set to `0` to disable periodic pruning (startup prune still runs). Note: `0` can only be set via project settings — the CLI flag does not accept zero. |
| `worker_stale_soft_ms` | integer | `1800000` | Inactivity before soft alert — emits `worker_needs_attention` notification (30 min). |
| `worker_stale_nudge_ms` | integer | `3600000` | Inactivity before PTY nudge message (60 min). |
| `worker_stale_force_fail_ms` | integer | `7200000` | Inactivity before force-fail with `policy: requeue` (2 hours). |
| `merge_strategy` | string | `"direct"` | `"direct"` for worktree merge, `"pr"` for pull request. |
| `pr_provider` | string\|null | `null` | Git host provider (`"github"`). Required when `merge_strategy` is `"pr"`. |
| `pr_push_remote` | string | `"origin"` | Git remote to push PR branches to. |
| `pr_finalize_lease_ms` | integer | `86400000` | Claim lease duration for PR finalization (24h). |

All `coordinator` fields can also be passed as CLI flags to `coordinator.ts` (e.g., `--tick-interval-ms=10000`). CLI flags override project settings.

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

In every mode, workers and scouts never start the master's orchestrator MCP server, which the repository's `.mcp.json`, `.codex/config.toml` or `.gemini/settings.json` would otherwise start inside them. Claude (`--strict-mcp-config`) and Gemini (`--allowed-mcp-server-names` with no matching name) start no MCP servers at all. Codex merges `-c` overrides into its configuration rather than replacing it, so its workers and app-server runtime disable the server named `orchestrator` (`-c mcp_servers.orchestrator={command="true",enabled=false}`); other servers in your Codex configuration still start. Workers reach the orchestrator only through the `orc` CLI.

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

Environment variables take precedence over all stored settings (see [Resolution Order](#resolution-order)).

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
- the control socket, not the state directory: the coordinator applies a project worker's lifecycle commands (see **Global project registry**).
- the `.git` subtrees a worktree commit/rebase/fetch writes — `objects/`, `refs/`, `logs/`, and `worktrees/` — of the registered target repository that backs the worktree. A linked worktree shares its main repo's object store, refs and per-worktree state, all of which lie outside the worktree directory.

Any of these that already lies inside the launch directory is omitted. The `.git` grant is scoped to those subtrees rather than the whole `.git` directory on purpose: `.git/hooks` and `.git/config` are **excluded**, so a sandboxed worker cannot plant a hook script or rewrite git config that the unsandboxed coordinator would later execute during a merge, push, or worktree operation. The project state directory and the target working tree are not writable. Workers never edit a task spec's `status:`; task status is runtime-owned. Its own session secret lets it change only its own run, through the coordinator; a Claude-sandboxed worker cannot read the operator token, while a Codex-sandboxed one can.

A project session (worker or scout) also connects to its coordinator's control socket. That is a network permission in Claude's sandbox. The settings always name the socket's path (`network.allowUnixSockets`), which macOS honours. Linux ignores socket paths (its seccomp filter cannot match them), so there the socket is reachable only when `worker_pool.sandbox_network` is `open`, which sets `network.allowAllUnixSockets: true` for workers and scouts. That lets a sandboxed worker or scout connect to **every** Unix socket it can reach, for example the Docker daemon (`/var/run/docker.sock`, root-equivalent), an SSH agent, D-Bus, or orc's private tmux server, through which it could type into other sessions' panes. Enable it only where those sockets are absent or not reachable from the sandbox; otherwise run Linux workers with `full-access` and accept that they are not sandboxed. Without `open` a Claude scout on Linux cannot report for duty, and `request_scout` fails after its readiness timeout. These keys match the Claude Code CLI's settings schema; a live connection under the Linux sandbox was not exercised, because the build environment cannot create the namespaces `bwrap` needs.

#### Codex (`codex`)

| Preset | Flags passed |
|--------|-------------|
| `full-access` | `--dangerously-bypass-approvals-and-sandbox` |
| `sandbox` | `--sandbox workspace-write --ask-for-approval never` |

`workspace-write` covers the launch directory (the assigned worktree). Codex sandbox mode additionally passes a config override granting the same extra roots as Claude — the control socket and the target repository's `.git` subtrees (`objects/`, `refs/`, `logs/`, `worktrees/`) — with the same `hooks/` + `config` exclusion. The value is JSON-encoded so paths with special characters stay well-formed:

```
-c sandbox_workspace_write.writable_roots=["<control-socket>","<target>/.git/objects","<target>/.git/refs","<target>/.git/logs","<target>/.git/worktrees"]
```

A project worker reaches its coordinator only through the control socket, and `workspace-write` blocks network access, Unix sockets included; Codex's per-socket allowance (`network.allow_unix_sockets`) belongs to its permission-profile network proxy, not to the `workspace-write` mode orc uses. So a sandboxed Codex project worker can run its lifecycle commands only with `worker_pool.sandbox_network: open`, which adds `-c sandbox_workspace_write.network_access=true` (the app-server runtime sets the same key in its thread config). That keeps the filesystem confinement but gives every command the worker runs full network access. With the default `restricted`, its lifecycle commands fail with a refused connection, and `orc doctor` warns. A read-only Codex scout has no network setting, so in a project it cannot report for duty and `request_scout` fails after its readiness timeout; request a `claude` scout instead (`provider` argument), which reaches the socket on macOS, and on Linux with `open`.

> **Note:** these override forms were not verifiable against a live Codex sandbox when they shipped: Codex's Linux sandbox needs unprivileged user namespaces, which the build environment lacks. If Codex sandbox commits or `orc` calls fail, check the `sandbox_workspace_write.writable_roots` and `sandbox_workspace_write.network_access` keys against your installed `codex` version and adjust `codexSandboxWritableRootArgs` / `codexSandboxNetworkArgs` in `adapters/pty.ts`.

#### Gemini (`gemini`)

Gemini does not have a sandbox CLI flag. The `execution_mode` field is accepted and stored, but no extra flags are passed at either preset level.

### Scout Override

Scouts are launched with `read_only: true`, which tightens their permissions when `execution_mode` is `sandbox`:

- For Codex sandbox: the sandbox scope is `read-only` instead of `workspace-write`.
- For Claude sandbox: filesystem writes are blocked entirely (no `allowWrite` entry in the settings file).
- In a registered project with `worker_pool.sandbox_network: open`, a Claude scout on Linux may connect to every Unix socket it can reach (see Claude above). It still cannot write files, but through such a socket (Docker, orc's tmux server) it could change other sessions, so it is no longer strictly read-only.

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
3. Project setting, section-specific value (project over global)
4. Project setting `default_provider` / `default_execution_mode` (for provider and execution mode fields)
5. Built-in default (lowest)

## State Directory Layout

The project state directory (`<data-home>/projects/<project_id>/`, see **Global project registry**) contains, among others:

```
<data-home>/projects/<project_id>/
  project.json          # Project descriptor (id, name, target root)
  runtime.db            # SQLite task store: revisions, status, transitions, runs, plans
  backlog.json          # Read-only projection of the project's tasks
  agents.json           # Registered agent records
  claims.json           # Active and recent claim records
  events.db             # SQLite event store
  memory.db             # SQLite memory store
  run-worktrees.json    # Mapping of run IDs to worktree paths
  pty-hook-events/      # Per-agent NDJSON hook event files
  worktrees/            # Run worktrees (<run_id>)
```

These files are managed exclusively by `orc` CLI commands and the coordinator. Do not edit them directly.

## Minimal Setup

The simplest way to get started:

```bash
export ORC_MAX_WORKERS=2
export ORC_WORKER_PROVIDER=claude
orc start-session
```

Or equivalently with stored project settings:

```bash
orc project config set default_provider claude
orc project config set worker_pool.max_workers 2
orc start-session
```

## See also

- [Getting started](./getting-started.md)
- [CLI reference](./cli.md)
- [Contracts & invariants](./contracts.md)
