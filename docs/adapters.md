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
| `survivesCoordinatorExit(handle)` | true for tmux: the coordinator must not stop it on exit |
| `detectInputBlock(handle, hookEvents)` | blocking prompt line or `null`; first permission hook message, else output scan. Adapters never read hook files |
| `capabilitiesFor(handle)` | CLI capabilities or the app-server's (`adapters/runtime.ts`) |
| `submit(handle, text, options?)` | acknowledged input; `app:` only, CLI sessions reject with `CapabilityRefusal` |
| `onEvent(listener)` / `turnActive(handle)` | app-server runtime events / turn in progress |

## Claude hooks

The tmux adapter writes a Claude settings file whose hooks run `hooks/orc-hook.ts` (`dist/hooks/orc-hook.js`) as `node <script> <kind> <events-file>`. Each call appends at most one record and exits 0. The coordinator tick is the only reader.

| Hook | Kind | Record |
|------|------|--------|
| `Notification` | `permission` | `{type:'permission', message, ts}` for `permission_prompt` |
| `PreToolUse` (`*`) | `tool_start` | `{type:'tool_start', tool, id?, ts}` (`id` = `tool_use_id`); the call is in flight (run not stalled) until its `tool` record or a `turn_end`, for up to 1 h. A start without `id` is closed by the next `tool_start` once a later call finished |
| `PostToolUse` / `PostToolUseFailure` (`*`) | `tool` | `{type:'tool', tool, brief, id?, ts}`; `brief` ≤ 80 chars; `Agent`/`Task` add `subagent_type` (infers the review phase) |
| `PreToolUse` (`TodoWrite\|TaskCreate\|TaskUpdate`) | `todo` | `{type:'activity', label, source:'todo', ts}`; empty label clears it |
| `Stop` (task workers) | — | runs `orc stop-check`: blocks the turn end while the run is unfinished (`stop_blocked`, capped); the coordinator appends `{type:'turn_end', ts}`, closing every open tool call |

- Scouts get only `Notification` (hook files are drained only for runs with an active claim).
- Orphaned hook files are removed at coordinator start and by `orc worker-gc` (`lib/hookFiles.ts`).
- Codex and Gemini get no hooks, so they keep the `worker_stale_*` thresholds instead of `hook_idle_*` ([configuration.md](./configuration.md)).
