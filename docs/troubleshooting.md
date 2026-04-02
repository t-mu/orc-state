# Troubleshooting

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

Then re-run `orc start-session`.

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
rm -rf .worktrees/<run_id>
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
orc worker-clearall
```

---

## Worker stuck or unresponsive

**Cause:** A worker is in `in_progress` but is not advancing — often due to a blocking tool call, a hung subprocess, or an error the worker did not surface.

**Fix:**

1. Inspect the worker's output log:
   ```bash
   orc attach <agent-id>
   ```
2. Check for stale claims and lifecycle issues:
   ```bash
   orc doctor
   ```
3. If the worker is genuinely stuck, remove it and reset the task:
   ```bash
   orc worker-remove <agent-id>
   orc task-reset <task-ref>
   ```
4. Re-dispatch the task:
   ```bash
   orc delegate
   ```

---

## Backlog sync mismatch

**Cause:** The markdown spec in `backlog/` and the runtime state in `.orc-state/backlog.json` have diverged — a field was edited in one place but not the other.

**Fix:**

Run the sync check to see which tasks are mismatched:

```bash
orc backlog-sync-check
```

Re-register the affected task to bring runtime state in sync with the spec:

```bash
orc task-create   # if the runtime record is missing entirely
```

Or edit the spec frontmatter to match the runtime state, then re-run the sync check.

---

## `orc doctor` reports state errors

**Cause:** One or more state files (`.orc-state/backlog.json`, `agents.json`, `claims.json`) failed schema validation, or were edited manually and are now malformed.

**Fix:**

Run doctor with `--json` for the full error list:

```bash
orc doctor --json
```

Do not edit state files directly. Use `orc` CLI commands to mutate state. If a file is corrupted beyond recovery, stop all sessions and restore from the last good git commit:

```bash
orc kill-all
git checkout HEAD -- .orc-state/
orc start-session --provider=claude
```
