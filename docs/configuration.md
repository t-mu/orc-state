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

Project lookup uses `--project`, then `ORC_PROJECT_ID`, then the current repository's canonical Git root, then the selected project only outside a Git repository. An unknown or ambiguous match is an error. Settings are validated against known non-secret config keys. Effective values resolve from CLI overrides, environment, project settings, then global settings. `project config list` shows effective values; `--global` shows stored global values. This registry is available now; existing coordinator commands still use the legacy config and state layout until the subsequent project-store integration tasks switch them.

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

Lifecycle fields (`status`, `attempt_count`, `blocked_reason`, `owner`, `planning_state`, …) are ignored and reported in `ignored_fields`; `--strict` rejects them instead. An import therefore cannot complete, block, or reopen a task. A file whose `status` is anything other than `todo` cannot create a new task, because it would start as dispatchable work: bring an existing installation's finished and blocked tasks over with the installation migration (plan 3, step 9), which carries runtime status, or remove the field to import the spec as new work.

For an existing task the file is the whole definition: an omitted field is cleared (dependencies, review level, provider) rather than kept, and `depends_on: []` is valid. The whole import runs in one transaction, so a file that fails any check leaves the project unchanged. Unlike backlog sync, the title falls back to the first `# ` heading rather than the slug, and duplicate dependencies are merged rather than rejected.

Export writes frontmatter for the definition fields plus `spec_revision` and `content_hash`, followed by the stored body. It never writes `status`. Re-importing an exported file uses its `spec_revision` as the expected revision, so editing a stale export fails with a revision conflict instead of overwriting newer work. Plans are stored whole in `plan_documents` after `parsePlan` validation and export byte-for-byte.

## Environment Variables

### Core Paths

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_STATE_DIR` | Root directory for all state files (backlog.json, agents.json, claims.json, events.db) | `<orchestration-root>/.orc-state` |
| `ORC_HOME` | Force the orchestration root (where state, backlog, plans, and config live). Top precedence for orchestration-root resolution; the coordinator propagates it into worker sessions so `orc` resolves the orchestration state dir from inside a target-repo worktree. See [Sibling Mode](./sibling-mode.md). | Walk-up to `orc-state.config.json`, else git root |
| `ORC_REPO_ROOT` | Force the repository root path instead of auto-detecting via `git rev-parse`. Also forces the target repo root for git operations. A forcing/recovery override — it does **not** by itself enable sibling mode (that is driven by the `target_repo` config key). | Auto-detected from cwd |
| `ORC_CONFIG_FILE` | Path to the config file | `<orchestration-root>/orc-state.config.json` |
| `ORC_WORKTREES_DIR` | Directory where run worktrees are created | `<orchestration-root>/.worktrees` |
| `ORC_BACKLOG_DIR` | Directory containing backlog task spec markdown files | `<orchestration-root>/backlog` |
| `ORC_PLANS_DIR` | Directory containing plan artifact markdown files | `<orchestration-root>/plans` |
| `ORC_SESSION_TRANSPORT` | Transport for new worker sessions: `auto` (tmux if installed, else node-pty), `tmux` or `pty`. tmux sessions survive a coordinator restart | `auto` |
| `ORC_TMUX_BIN` | tmux binary used by the tmux session transport | `tmux` |
| `ORC_CONTROL_API` | Set to `off` to stop the coordinator serving the local control API (`control.sock`, `control.json`, `control.token` in the state dir) | on |

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

### `target_repo`

Path to the product repository that orc operates on, enabling the **sibling
layout**. When set, orc runs from the orchestration root (which holds state,
backlog, plans, and config) while all product-code git operations target this
repo, so no framework files land in the product repo. A relative path resolves
against the config file's directory (the orchestration root); an absolute path
is used as-is. Absent (the default), the orchestration root and target repo are
the same directory — the attached, single-repo layout.

Set this with `orc init --sibling=<target-repo-path>` rather than by hand. See
[Sibling Mode](./sibling-mode.md) for the full model and operating contract.

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
- the state directory (`.orc-state/`). It stays writable deliberately: a sandboxed worker mutates runtime state only indirectly, by running `orc` lifecycle commands (`run-start`, `progress`, `run-work-complete`, `review-submit`, `memory-record`, …) from inside its own session, and those commands write the event log, claims, and memory store under `.orc-state/`.
- the `.git` subtrees a worktree commit/rebase/fetch writes — `objects/`, `refs/`, `logs/`, and `worktrees/` — of the repo that backs the worktree: the orchestration repo in the attached layout, `<target-repo>` in the [sibling layout](./sibling-mode.md). A linked worktree shares its main repo's object store, refs and per-worktree state, all of which lie outside the worktree directory.

Any of these that already lies inside the launch directory is omitted. The `.git` grant is scoped to those subtrees rather than the whole `.git` directory on purpose: `.git/hooks` and `.git/config` are **excluded**, so a sandboxed worker cannot plant a hook script or rewrite git config that the unsandboxed coordinator would later execute during a merge, push, or worktree operation. The rest of the orchestration root (main checkout, `backlog/`, `plans/`) is not writable; attached-layout workers edit the task spec copy inside their worktree. The sandbox does not isolate the worker from state it legitimately writes through the CLI.

#### Codex (`codex`)

| Preset | Flags passed |
|--------|-------------|
| `full-access` | `--dangerously-bypass-approvals-and-sandbox` |
| `sandbox` | `--sandbox workspace-write --ask-for-approval never` |

`workspace-write` covers the launch directory (the assigned worktree). Codex sandbox mode additionally passes a config override granting the same extra roots as Claude — the state directory and the backing repo's `.git` subtrees (`objects/`, `refs/`, `logs/`, `worktrees/`) — with the same `hooks/` + `config` exclusion. The value is JSON-encoded so paths with special characters stay well-formed:

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
