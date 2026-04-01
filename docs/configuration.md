# Configuration

orc-state is configured through environment variables and an optional JSON config file. Environment variables take precedence over config file values.

## Environment Variables

### Core Paths

| Variable | Description | Default |
|----------|-------------|---------|
| `ORCH_STATE_DIR` | Root directory for all state files (backlog.json, agents.json, claims.json, events.db) | `<repo-root>/.orc-state` |
| `ORC_REPO_ROOT` | Force the repository root path instead of auto-detecting via `git rev-parse` | Auto-detected from cwd |
| `ORC_CONFIG_FILE` | Path to the config file | `<repo-root>/orchestrator.config.json` |
| `ORC_WORKTREES_DIR` | Directory where run worktrees are created | `<repo-root>/.worktrees` |
| `ORC_BACKLOG_DIR` | Directory containing backlog task spec markdown files | `<repo-root>/backlog` |

### Worker Pool

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_MAX_WORKERS` | Maximum number of concurrent worker agents | `0` (set via config or CLI) |
| `ORC_WORKER_PROVIDER` | Provider for worker agents (`claude`, `codex`, or `gemini`) | `codex` (or config `default_provider`) |
| `ORC_WORKER_MODEL` | Model identifier for worker agents | Provider default |

### Master Agent

| Variable | Description | Default |
|----------|-------------|---------|
| `ORC_MASTER_PROVIDER` | Provider for the master agent | `claude` (or config `default_provider`) |
| `ORC_MASTER_MODEL` | Model identifier for the master agent | Provider default |

### Testing

| Variable | Description |
|----------|-------------|
| `ORC_STRICT_PTY_TESTS` | Set to `1` to fail tests when PTY support is unavailable |
| `ORC_PTY_AVAILABLE` | Set to `1` to skip PTY probe and assume PTY is available |

## Config File

Location: `orchestrator.config.json` in the repository root (sibling of `.orc-state/`). Override the path with `ORC_CONFIG_FILE`.

### Full Schema

```json
{
  "default_provider": "claude",
  "master": {
    "provider": "claude",
    "model": "claude-sonnet-4-20250514"
  },
  "worker_pool": {
    "max_workers": 3,
    "provider": "codex",
    "model": "o4-mini",
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
    "session_start_retry_delay_ms": 30000
  },
  "leases": {
    "default_ms": 1800000,
    "finalize_ms": 3600000
  }
}
```

All fields are optional. Omitted fields use their defaults.

### `default_provider`

Sets the fallback provider for both master and worker pool when neither a section-specific provider nor an environment variable is set. Must be `claude`, `codex`, or `gemini`.

### `master`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"claude"` | Provider for the master agent |
| `model` | string | `null` | Model override for the master agent |

### `worker_pool`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_workers` | integer | `0` | Maximum concurrent workers |
| `provider` | string | `"codex"` | Default provider for workers |
| `model` | string | `null` | Default model for all workers |
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

All `coordinator` fields can also be passed as CLI flags to `coordinator.ts` (e.g., `--tick-interval-ms=10000`). CLI flags override config file values.

### `leases`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_ms` | integer | `1800000` (30 min) | Default claim lease duration |
| `finalize_ms` | integer | `3600000` (60 min) | Extended lease for the finalize phase |

## Resolution Order

For any setting that can be specified in multiple places, the precedence is:

1. CLI flag (highest)
2. Environment variable
3. Config file section-specific value
4. Config file `default_provider` (for provider fields only)
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
