# Recovery and Troubleshooting

`$STATE` = the project state directory (`stateDir` in `orc project show`). Never edit state files; use `orc` commands. Command flags: [cli.md](./cli.md). Lifecycle, liveness and lease rules: [contracts.md](./contracts.md).

## Runtime Database Upgrade and Restore

Back up before running a newer binary (stop the coordinator and workers; needs `sqlite3`):

```bash
sqlite3 "$STATE/runtime.db" ".backup '$STATE/runtime.db.pre-upgrade'"
sqlite3 "$STATE/events.db"  ".backup '$STATE/events.db.pre-upgrade'"
cp "$STATE/claims.json" "$STATE/claims.json.pre-upgrade"
cp "$STATE/agents.json" "$STATE/agents.json.pre-upgrade"
```

Restore (all database users stopped; events after the backup are lost):

```bash
mv "$STATE/events.db" "$STATE/events.db.failed"
rm -f "$STATE"/events.db-wal "$STATE"/events.db-shm "$STATE"/runtime.db-wal "$STATE"/runtime.db-shm
cp "$STATE/events.db.pre-upgrade"   "$STATE/events.db"
cp "$STATE/runtime.db.pre-upgrade"  "$STATE/runtime.db"
cp "$STATE/claims.json.pre-upgrade" "$STATE/claims.json"
cp "$STATE/agents.json.pre-upgrade" "$STATE/agents.json"
orc doctor
```

- Migrations apply on first open, one transaction each; `orc doctor` reports `runtimeSchema.version`. A database from a newer binary is refused.
- Never edit `PRAGMA user_version` or migration records to force a downgrade.
- `backlog.json` is a projection of `runtime.db`; it needs no backup.

## Sessions and coordinator

| Symptom | Check | Fix |
|---------|-------|-----|
| `No registered project here…` | `orc project list` | `orc project add <git-path>`; outside a repo `orc project select <id>` or `--project=<id>` |
| `target repository is not a git repository` (doctor) | `git -C <path> rev-parse` | `git init` and commit, then `orc project add`, `orc init` |
| Coordinator not running | `orc status`, `orc doctor` | `orc start-session` keeps runtime state: tmux sessions are adopted (`session_reconciled` outcome `adopted`, runs stay `in_progress`), `app:` runs are requeued, legacy `pty:` sessions (from an older orc) are cleared and their runs requeued. To discard the runs instead: `orc start-session --reset` stops every worker session and requeues their tasks |
| `orc doctor` reports a live coordinator whose `coordinator.pid` is missing or wrong | `orc doctor` | `orc kill-all` finds it via `control.json`, then `orc start-session` |
| Repeated `session_start_failed` | `orc events-tail --event=session_start_failed`, [Providers](#providers) | fix install/auth; the task is requeued after the retries; `orc task-reset <ref>` if it stays stuck |
| `session_resume_failed`, or a worker that keeps crashing and resuming | `orc events-tail --event=session_resumed`, `orc events-tail --event=session_resume_failed` | Each run resumes at most twice, then is requeued. To stop resuming: `orc project config set sessions.resume off` (read at each decision), or start the coordinator with `ORC_SESSIONS_RESUME=off`. A dead worker pane stays in tmux (`remain-on-exit`) until the coordinator stops the session. [Session Resume](configuration.md#session-resume) |
| `orc status` shows `master … offline` while the master's tmux pane runs (its tools report an invalid secret) | `orc events-tail --event=master_retired` (the probe that retired it), `orc sessions --all` | `orc start-session`: it restores the record and session from the live pane and reattaches. If it starts a new master instead, no closed session matched the pane's pid/start |
| `orc status` shows unexpected `configured_slots` / provider | `orc project config list`, `env \| grep '^ORC_'` | `orc project config set worker_pool.max_workers <n>` / `worker_pool.provider <name>`; an exported `ORC_MAX_WORKERS` / `ORC_WORKER_PROVIDER` wins |
| `orc doctor` reports state errors | `orc doctor --json` | stop sessions, [restore](#runtime-database-upgrade-and-restore); state is outside the repo, Git cannot restore it |
| State inconsistent beyond the fixes here | `orc doctor --json`, `orc status` | [Full reset](#full-reset) |

### Recoverable or Unknown Sessions

`orc sessions` shows `state=recoverable|unknown` with a `reason:`; the coordinator never kills or redispatches them.

- `recoverable`: process alive, this coordinator cannot write to it. The worker can still run `orc run-*`; it gets no nudges or envelopes.
- `unknown`: live process does not match the recorded PID + start time, or has no recorded identity. Not adopted.
- Fix: let it finish, or `orc task-reset <ref>` (or `orc task-cancel <ref>`), then `orc worker-remove <agent_id>` (refused while a claim is active; signals only a matching process).
- Prevent: keep tmux ≥ 3.2 installed (`orc doctor` checks it).

## Runs and claims

| Symptom | Check | Fix |
|---------|-------|-----|
| Worker stuck in `in_progress` | `orc attach <agent_id>` (read-only, `--write` to type), or `orc terminal provider <run_id> --once` without a TTY; `orc doctor` | `orc task-reset <ref>`, then `orc worker-remove <agent_id>`; dispatch is automatic |
| Dead worker, claim not released | `orc runs-active`, `orc doctor` | a dead process expires the claim at once; else `orc task-reset <ref>` |
| Offline/dead workers left in `orc status` (`idle\|running\|offline\|dead`) | `orc status` | a running coordinator removes them; without one `orc worker-gc` (keeps workers with a claim) |
| Worker blocked on `run-input-request` | `orc waiting-input` | `orc run-input-respond --run-id=<id> --agent-id=<id> --response="…"`; otherwise it fails on timeout and is requeued |
| Task `blocked` | `orc status`, `orc project task show <ref>` | fix the cause, `orc task-unblock <ref>` |
| Task never dispatched | `orc project task show <ref>` (`depends_on`) | finish the dependency; `orc task-reset <dep-ref>` if it is stuck |
| `finalization_state=blocked_finalize` | `orc status`, `orc run-info <run_id>` | [Finalization Failure](#finalization-failure-blocked_finalize) |

### Finalization Failure (`blocked_finalize`)

The coordinator could not finish its merge flow; work is kept in `<state>/worktrees/<run_id>` on branch `task/<run_id>`. If the worker is still live, use the finalize-rebase handoff. Otherwise merge by hand, from the main checkout for the last three commands:

```bash
cd <state>/worktrees/<run_id>        # commit any leftover change first
git rebase main && npm test
git -C <main-repo> merge task/<run_id> --no-ff -m "task(<task_ref>): merge worktree"
orc task-mark-done <task_ref>
orc run-close <run_id> --reason="merged manually after blocked_finalize"
```

- `run-close` (MCP `close_run`) closes the claim and force-removes the worktree and branch; details in [cli.md](./cli.md). A branch not merged with a merge commit keeps its worktree.
- Work that should be redone instead: `orc run-expire <run_id>` or `orc task-reset <task_ref>`.
- `run-close` does not stop the worker: `orc worker-remove <agent_id>`. Do not use `orc run-finish` here.

## Worktrees

Run worktrees live at `<state>/worktrees/<run_id>`, registered in `$STATE/run-worktrees.json`.

| Symptom | Check | Fix |
|---------|-------|-----|
| Worktree left after a run finished or failed | `git worktree list` vs `orc runs-active` | `git worktree remove [--force] <state>/worktrees/<run_id>`, then `git worktree prune` |
| Worktree creation fails (path exists) | `git worktree list` | `git worktree prune`; `rm -rf <state>/worktrees/<run_id>` if it remains; `orc task-reset <ref>` |

## Providers

| Provider | Install | Auth |
|----------|---------|------|
| Claude | `npm install -g @anthropic-ai/claude-code` | run `claude` and log in, or `ANTHROPIC_API_KEY` |
| Codex | `npm install -g @openai/codex` | run `codex` and log in, or `OPENAI_API_KEY` |
| Gemini | `npm install -g @google/gemini-cli` | run `gemini` and log in, or `GEMINI_API_KEY` / `GOOGLE_API_KEY` |

`Binary '<x>' not found on PATH` → install, open a new shell, `orc doctor`. Auth failures are not caught by `orc doctor`: run the CLI once by hand.

## Tests

| Symptom | Check | Fix |
|---------|-------|-----|
| An `ORC_*` switch has no effect in tests | — | configs strip inherited `ORC_*`; use the `RUN_*` switches ([testing.md](./testing.md#env-switches)) |
| tmux suites skipped | `tmux -V` | install tmux ≥ 3.2 |
| Real-provider test skips | `RUN_REAL_PROVIDERS=1` set? binary on `PATH`? | set the switch, install the binary |
| Real-provider test times out | provider CLI by hand (first-run or auth prompt) | log in, rerun |

## Full reset

```bash
orc kill-all [--keep-sessions]
orc start-session
```

`kill-all` stops the coordinator, stops every agent session, clears `agents.json`, resets `claimed`/`in_progress` tasks to `todo`, cancels their claims (`run_cancelled`, reason `kill_all`) and **removes every run worktree** in `run-worktrees.json`. Unmerged work is lost: merge or copy it first.

`--keep-sessions` stops the coordinator but leaves agent sessions running; their agent records, session rows, active runs and worktrees are kept, so `orc start-session` adopts them (a session that already exited is reconciled `exited` and its run resumed or requeued). Everything else is reset as above.

`orc start-session --reset` is the reset without `kill-all`: it stops the coordinator and every worker session, fails their runs (`session_reset`) and requeues the tasks; worktrees stay. It refuses while a master runs (exit the master first), while the coordinator cannot be stopped, or when a worker session cannot be stopped (`orc kill-all` then). If the master then fails to start, the reset stands.
