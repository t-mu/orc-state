# Configuration

orc-state is configured through environment variables and an optional JSON config file. Environment variables take precedence over config file values.

## Environment Variables

### Core Paths

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_STATE_DIR` | Root directory for all state files (backlog.json, agents.json, claims.json, events.db) | `<repo-root>/.orc-state` |
| `ORC_REPO_ROOT` | Force the repository root path instead of auto-detecting via `git rev-parse` | Auto-detected from cwd |
| `ORC_CONFIG_FILE` | Path to the config file | `<repo-root>/orc-state.config.json` |
| `ORC_WORKTREES_DIR` | Directory where run worktrees are created | `<repo-root>/.worktrees` |
| `ORC_BACKLOG_DIR` | Directory containing backlog task spec markdown files | `<repo-root>/backlog` |

### Worker Pool

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_MAX_WORKERS` | Maximum number of concurrent worker agents | `0` (set via config or CLI) |
| `ORC_WORKER_PROVIDER` | Provider for worker agents (`claude`, `codex`, or `gemini`) | `codex` (or config `default_provider`) |
| `ORC_WORKER_MODEL` | Model identifier for worker agents | Provider default |
| `ORC_WORKER_EXECUTION_MODE` | Execution mode for worker agents (`full-access` or `sandbox`) | `full-access` |

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

### `master`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"claude"` | Provider for the master agent |
| `model` | string | `null` | Model override for the master agent |
| `execution_mode` | string | `"full-access"` | Execution mode for the master agent (`full-access` or `sandbox`) |

### `worker_pool`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_workers` | integer | `0` | Maximum concurrent workers. Default: `0`. `orc init` generates a config with `max_workers: 1` for immediate usability. |
| `provider` | string | `"codex"` | Default provider for workers |
| `model` | string | `null` | Default model for all workers |
| `execution_mode` | string | `"full-access"` | Execution mode for worker agents (`full-access` or `sandbox`) |
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

In `sandbox` mode, a Claude settings file is also written that sets `allowUnsandboxedCommands: false` and restricts filesystem writes to the working directory.

#### Codex (`codex`)

| Preset | Flags passed |
|--------|-------------|
| `full-access` | `--dangerously-bypass-approvals-and-sandbox` |
| `sandbox` | `--sandbox workspace-write --ask-for-approval never` |

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
