# Troubleshooting

For multi-step recovery procedures, see [Recovery guide](./recovery.md).

Common issues and recovery paths for `orc-state`.

---

## "Binary 'X' not found on PATH" / Provider not found

**Cause:** The provider CLI binary (`claude`, `codex`, or `gemini`) is not installed or not on `$PATH`.

**Fix:**

Install the missing provider:

```bash
# Claude (Anthropic)
npm install -g @anthropic-ai/claude-code

# Codex (OpenAI)
npm install -g @openai/codex

# Gemini (Google)
npm install -g @google/gemini-cli
```

After installing, open a new shell session so the updated `$PATH` takes effect, then verify:

```bash
orc doctor
```

---

## Provider authentication failure

**Cause:** The provider binary is installed but not authenticated — missing API key, expired token, or no active login session.

**Fix by provider:**

**Claude:** Run `claude` in a terminal. It will prompt you to log in via browser or enter an API key. Alternatively, set the `ANTHROPIC_API_KEY` environment variable.

**Codex:** Run `codex` in a terminal and follow the OpenAI login flow, or set `OPENAI_API_KEY`.

**Gemini:** Run `gemini` in a terminal to complete Google authentication, or set `GEMINI_API_KEY` / `GOOGLE_API_KEY`.

After authenticating, confirm the provider works:

```bash
orc doctor
```

---

## "Must run inside a git repository"

**Cause:** `orc` requires a git repository because task isolation relies on git worktrees. Running outside a repo causes this error.

**Fix:** Initialise a git repo in your project root:

```bash
git init
git add -A
git commit -m "initial commit"
```

Then register it (`orc project add <path>`), run `orc init`, and re-run `orc start-session`.

---

## Worktree creation failures

**Cause:** A worktree cannot be created if the target directory already exists, or if an old worktree was not cleaned up after a previous run.

**Fix:** List and prune stale worktrees:

```bash
git worktree list
git worktree prune
```

If a specific worktree directory still exists after pruning, remove it manually:

```bash
rm -rf "<project state directory>/worktrees/<run_id>"   # see orc project show
git worktree prune
```

Then reset the task and re-dispatch:

```bash
orc task-reset <task-ref>
orc delegate
```

---

## Coordinator crash / stale coordinator

**Cause:** The coordinator process was killed mid-run or exited unexpectedly. Subsequent `orc status` commands may show workers stuck in `in_progress` or claims that never expire.

**Fix:**

1. Check whether the coordinator is still running:
   ```bash
   orc status
   ```
2. If it is not running, start a new session (this restarts the coordinator and master):
   ```bash
   orc start-session --provider=claude
   ```
3. For a full reset when the session state is corrupted:
   ```bash
   orc kill-all
   orc start-session --provider=claude
   ```

Active claims from the crashed session will be expired and requeued on the next coordinator tick.

---

## Stale claims / expired leases

**Cause:** A worker stopped sending heartbeats (crashed, lost connectivity, or was killed). After 30 minutes without a heartbeat the coordinator marks the claim stale and requeues the task.

**Fix:**

Inspect stale claims:

```bash
orc doctor
orc runs-active
```

Reset the task to clear the stale claim and make it eligible for dispatch again:

```bash
orc task-reset <task-ref>
```

Remove any lingering offline workers:

```bash
orc worker-gc
```

---

## Worker stuck or unresponsive

**Cause:** A worker is in `in_progress` but is not advancing — often due to a blocking tool call, a hung subprocess, or an error the worker did not surface.

**Fix:**

1. Watch the worker's live terminal (read-only; Ctrl-b d detaches):
   ```bash
   orc attach <agent-id>
   ```
   Add `--write` to type into it. For a `pty:` session, or without a TTY, use
   `orc terminal provider <run_id> --once`.
2. Check for stale claims and lifecycle issues:
   ```bash
   orc doctor
   ```
3. If the worker is genuinely stuck, reset the task (this releases its claim),
   then remove the worker (`worker-remove` refuses while a claim is active):
   ```bash
   orc task-reset <task-ref>
   orc worker-remove <agent-id>
   ```
4. Re-dispatch the task:
   ```bash
   orc delegate
   ```

---

## `orc doctor` reports state errors

**Cause:** One or more state files in the project state directory (`backlog.json`, `agents.json`, `claims.json`) failed schema validation, or were edited manually and are now malformed.

**Fix:**

Run doctor with `--json` for the full error list:

```bash
orc doctor --json
```

Do not edit state files directly. Use `orc` CLI commands to mutate state. If a file is corrupted beyond recovery, stop all sessions and restore the state directory from a backup (see [Recovery guide → Runtime Database Upgrade and Restore](./recovery.md#runtime-database-upgrade-and-restore)); the state lives outside the repository, so Git cannot restore it:

```bash
orc kill-all
# restore the backup into the project state directory (orc project show)
orc start-session --provider=claude
```

## `orc doctor` or `orc preflight` fails with "No registered project here"

**Cause:** No registered project applies: `ORC_PROJECT_ID` is unset, the current Git repository is not registered, and (outside every repository) no project is selected. `orc init`, `orc start-session`, the coordinator and the MCP server refuse to start too. State, `backlog/` or config files an older orc left inside the repository are not read and cannot be imported.

**Fix:** Register the repository, or choose a project:

```bash
orc project add <git-path>
orc project select <id>      # used outside every Git repository
orc --project=<id> doctor    # one command
```

---

## `orc status` shows unexpected worker settings

**Cause:** Settings are registry keys, not a file. `configured_slots` and `provider` come from `worker_pool.max_workers` and `worker_pool.provider` (falling back to `default_provider`), with the project's value over the global one, and an exported `ORC_MAX_WORKERS` or `ORC_WORKER_PROVIDER` overrides both. No config file is read.

**Fix:** Check what the project actually resolves, then set the key:

```bash
orc project config list                          # effective values for this project
orc project config set worker_pool.max_workers 2
orc project config set worker_pool.provider claude
env | grep '^ORC_'                               # an exported override wins over both
```

---

## See also

- [Recovery guide](./recovery.md)
- [Contracts & invariants](./contracts.md)
- [CLI reference](./cli.md)
