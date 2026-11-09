# Provider Adapters

The core never talks to provider binaries; it calls an adapter. `createAdapter(provider)` (`adapters/index.ts`) accepts only `claude`, `codex`, `gemini`; there is no plug-in path. It returns one composite adapter that routes each call by session handle prefix:

| Handle | Adapter | Used when |
|--------|---------|-----------|
| `tmux:` | `adapters/tmux.ts` | every new terminal session; needs tmux ≥ 3.2 (start fails otherwise) |
| `app:` | `adapters/codexAppServer.ts` | Codex with `runtime: 'structured'` ([configuration.md → Worker Runtimes](./configuration.md)); other providers fall back to the CLI and record `runtime_fallback` |
| any other (`pty:` from an older orc) | none | reported offline: probe `false`, `inspectSession` `alive: false`, `send` throws; `stop` sends SIGTERM to the provider process recorded in `pty-pids/<agent>.pid` only if its pid and start time still match, then removes the session files; the coordinator clears it like a dead session |

Provider launch (binary, args, env, cwd, Claude settings/hooks, sandbox grants, startup-dialog keystrokes, prompt detection) is shared in `adapters/providerLaunch.ts`.

## Interface

Required (`AdapterInterface`, `adapters/interface.ts`; checked by `assertAdapterContract`):

| Method | Contract |
|--------|----------|
| `start(agentId, config)` → `{session_handle, provider_ref}` | `config`: `system_prompt`, `model`, `working_directory`, `env`, extras; `provider_ref` is opaque to the core |
| `send(handle, text)` → `string` | deliver input; throws on unknown handle or failed delivery; the return is not parsed |
| `attach(handle)` | print a snapshot of recent output (`(no messages yet)` if none); `orc attach` opens a real tmux client instead |
| `heartbeatProbe(handle)` → `boolean` | never throws |
| `stop(handle)` | no-op for an unknown session |
| `getOutputTail(handle, maxBytes?)` → `string \| null` | last 8 KB (or `maxBytes`), ANSI stripped, trimmed; `''` without a log, `null` on error. tmux reads the rendered pane (`capture-pane -J`, 10,000 lines scrollback) while it lives, the raw log after |

Optional (all present on the composite):

| Method | Purpose |
|--------|---------|
| `ownsSession(handle)` | this process can write to the session (absent → assumed) |
| `inspectSession(handle)` | `{transport, alive, writable, pid, processStart, reason?}`; drives `recoverable` / `unknown` ([recovery.md](./recovery.md#recoverable-or-unknown-sessions)) |
| `adoptSession(handle)` | reattach a live session another coordinator launched; returns an inspection (`app:` only, others are inspected as is). See [Codex app-server sessions](#codex-app-server-sessions) |
| `survivesCoordinatorExit(handle)` | true for tmux and `app:`: the coordinator must not stop it on exit |
| `exitStatus(handle)` | `{code, signal}` of a session that ended, or `null`; tmux reads the dead pane, `app:` its exit file |
| `detectInputBlock(handle, hookEvents)` | blocking prompt line or `null`; first permission hook message, else output scan. Adapters never read hook files |
| `capabilitiesFor(handle)` | CLI capabilities or the app-server's (`adapters/runtime.ts`) |
| `submit(handle, text, options?)` | acknowledged input; `app:` only, CLI sessions reject with `CapabilityRefusal` |
| `onEvent(listener)` / `turnActive(handle)` | app-server runtime events / turn in progress |

## Session capabilities

What a session can do depends on its provider and transport. `lib/sessionCapabilities.ts` holds the one table; resume (`providerSupportsResume`), readiness (`hasSessionStartHook`), the conversation id orc picks at launch (workers and the master) and terminal streaming read it. Session listings carry the row as `capabilities`: `GET /v1/sessions`, `orc sessions --json`, and the MCP `get_status` agent rows of agents with a session ([contracts.md](./contracts.md)).

| Provider | Transport | `resume` | `conversation_id` | `attach` | `terminal_input` | `readiness_hook` | `can_be_master` |
|----------|-----------|----------|-------------------|----------|------------------|------------------|-----------------|
| Claude | `tmux` | yes (`--resume`) | `orc` (`--session-id`) | yes | yes | `always` | yes |
| Codex | `tmux` | no | `provider` (from the hook; informational) | yes | yes | `full-access` | yes |
| Codex | `app-server` | yes (`thread/resume`) | `provider` (thread id) | no | no | `never` (protocol handshake) | no |
| Gemini | `tmux` | no | none (`null`) | yes | yes | `never` (report-for-duty) | yes |

- `resume`: a crashed worker session is relaunched in place ([configuration.md](./configuration.md) `sessions.resume`). `conversation_id`: who names the provider conversation (`orc` at launch, the `provider` once known, or `null`). `attach` / `terminal_input`: there is a tmux terminal to stream and type into. `readiness_hook`: [Session readiness](#session-readiness). `can_be_master`: `orc start-session` runs the master on it (the master is always a tmux session).
- Any other pair, such as a legacy `pty` session, has every capability off.
- Not the same as `capabilitiesFor(handle)`: that declares what a runtime's protocol supports (`adapters/runtime.ts`), not what orc does with the session.

## Codex app-server sessions

`adapters/codexAppServer.ts` runs `codex app-server --listen unix://<state>/app-server/<agent>.sock` detached, in its own process group, so it survives a coordinator restart. Codex speaks WebSocket on that socket (one JSON-RPC message per text frame, `adapters/unixWebSocket.ts`); a path too long for a Unix socket is a symlink Codex makes to a short one under `/tmp`.

| File (`<state>/app-server/`) | Written by | Holds |
|------------------------------|------------|-------|
| `<agent>.sock` | Codex | the listening socket |
| `<agent>.exit` | the `sh` wrapper that launches Codex | the exit code, or 128 + signal; absent while it runs or when `stop` signalled the whole group |
| `<agent>.turn.json` | the adapter, at each turn start and end | `{turn_id, command_id, finished}`: the command that started the latest turn, and whether its end was reported |

The session's recorded PID and `process_start` are the wrapper's; `stop` checks them, then signals the process group (SIGTERM, SIGKILL after 5 s if the group is still alive). A connection that closes while the process runs on is logged, not reported as an exit.

On start the coordinator adopts each live `app:` session (`adoptSession`, through session reconciliation):

1. The recorded PID and start time must still match. Otherwise the session is reported dead with the reason: `app-server exited (<code or signal>) while no coordinator was attached`, `PID <pid> now belongs to another process`, or `process <pid> is gone`.
2. It connects to the socket, initializes, and resumes the recorded thread (`thread/resume`). Codex cannot list the turns of a thread whose history is not written yet (`list_turns is not supported yet`, just after a turn starts), so the paginated resume falls back to a full one.
3. It reads the thread's last turn. A running turn keeps the session busy, and its events carry the command id from `<agent>.turn.json` (or the turn's `clientUserMessageId`). A turn that finished while no coordinator was attached (not marked `finished`) is reported now, so its command's ACK advances; a turn already reported is not reported again.

A live app-server that cannot be reattached (no recorded thread, socket or protocol failure) is stopped, so it does not keep working unsupervised. A dead or stopped session takes the dead-session path: resumed on its thread after a crash, otherwise requeued ([configuration.md → Session Resume](./configuration.md#session-resume)).

## Claude hooks

The tmux adapter writes a Claude settings file whose hooks run `hooks/orc-hook.ts` (`dist/hooks/orc-hook.js`) as `node <script> <kind> <events-file>`. Each call appends at most one record and exits 0. The coordinator tick is the only reader.

| Hook | Kind | Record |
|------|------|--------|
| `SessionStart` | `session_start` | `{type:'session_start', session_id, source, orc_session_id?, ts}`: Claude's conversation id, the start source (`startup`, `resume`, ...) and the orc session id from `ORC_SESSION_ID`. The session's readiness signal ([Session readiness](#session-readiness)); `full-access` Codex sessions run the same kind |
| `Notification` | `permission` | `{type:'permission', message, ts}` for `permission_prompt` |
| `PreToolUse` (`*`) | `tool_start` | `{type:'tool_start', tool, id?, ts}` (`id` = `tool_use_id`); the call is in flight (run not stalled) until its `tool` record or a `turn_end`, for up to 1 h. A start without `id` is closed by the next `tool_start` once a later call finished |
| `PostToolUse` / `PostToolUseFailure` (`*`) | `tool` | `{type:'tool', tool, brief, id?, ts}`; `brief` ≤ 80 chars; `Agent`/`Task` add `subagent_type` (infers the review phase) |
| `PreToolUse` (`TodoWrite\|TaskCreate\|TaskUpdate`) | `todo` | `{type:'activity', label, source:'todo', ts}`; empty label clears it |
| `Stop` (task workers) | — | runs `orc stop-check`: blocks the turn end while the run is unfinished, except before TASK_START is sent (`stop_blocked`, capped); the coordinator appends `{type:'turn_end', ts}`, closing every open tool call |

- Scouts get only `SessionStart` and `Notification`. Hook files are drained for runs with an active claim, and for a scout whose session is not ready yet (only its `session_start` record is used).
- Orphaned hook files are removed at coordinator start and by `orc worker-gc` (`lib/hookFiles.ts`).
- A `full-access` Codex session gets only `SessionStart` (as `-c` launch args, see [Session readiness](#session-readiness)) and Gemini none, so both keep the `worker_stale_*` thresholds instead of `hook_idle_*` ([configuration.md](./configuration.md)).

## Session readiness

The coordinator sends TASK_START (or `request_scout` the SCOUT_BRIEF) only once the session is ready. Each provider uses one readiness signal:

| Provider | Runtime | Readiness signal |
|----------|---------|------------------|
| Claude | tmux | `SessionStart` hook. The coordinator drains the `session_start` record, emits `reported_for_duty {source: 'hook'}` and stores `session_id` as `sessions.provider_conversation_id`. The bootstrap never mentions report-for-duty, and no report-for-duty `SESSION_NUDGE` is sent |
| Codex | tmux | `full-access` (Codex 0.163 or newer): `SessionStart` hook, passed per launch: `--dangerously-bypass-hook-trust -c 'hooks.SessionStart=[{hooks=[{type="command",command="node <orc-hook> session_start <events-file>"}]}]'` (`codexSessionStartHookArgs`), so nothing is written to the Codex home or the worktree. The TUI fires it when the bootstrap prompt starts the thread, before the model runs. Handled like Claude's record; Codex sessions are not resumed, so the stored conversation id is informational. The trust bypass applies to the whole invocation: hooks from the user's or the repository's `hooks.json` also run, without a trust prompt and outside the Codex sandbox. `sandbox` (every Codex scout): `orc report-for-duty`, which the bootstrap asks for (nudged), because the bypass would let repository hooks escape the sandbox. An older Codex rejects the flag, so the launch fails: upgrade Codex |
| Codex | `app:` | the app-server protocol handshake (`adapters/codexAppServer.ts`) |
| Gemini | tmux | `orc report-for-duty`, which the bootstrap asks for (nudged with `SESSION_NUDGE`). Gemini CLI documents a `SessionStart` hook, but only in settings files: the per-launch route (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) would replace the administrator's system settings, and the others write into the user's home or the worktree, so orc does not wire it |

- A record is applied only to the session it names: a different `orc_session_id` is dropped, and so is a record for a session that is already ready (a later `/clear` or compaction). A record that arrives before the launch is recorded waits in events.db (`pending_session_starts`, one per agent), so a restarted coordinator still applies it; one still waiting after `coordinator.session_ready_timeout_ms` is dropped.
- The `report-for-duty` op stays accepted for every provider: a session started by an older orc, or one whose hook misfires, still gets dispatched.
- A session that is not ready after `coordinator.session_ready_timeout_ms` is requeued with `ERR_SESSION_READY_TIMEOUT`, whatever its provider.
