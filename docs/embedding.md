# Embedding orc

How an app (Electron main process, a Node sidecar, a TUI) drives orc without shelling out to the CLI. Types and routes: [contracts.md → Package exports](contracts.md); settings: [configuration.md](configuration.md).

## Which entry to import

| Import | Use for | Cost |
|---|---|---|
| `orc-state/client` | An app or UI: `listProjects`, `ControlClient`, `ProjectWatcher`, `ControlError`, `RegistrySchemaError`, `tmuxSessionTarget`, and the types (including `TmuxTarget`) | No side effects on import; Node built-ins only (`node:sqlite` for `listProjects`). Safe in a bundle or a main process |
| `orc-state` (root) | Running orc in process: adapters, validators, bootstrap templates | Resolves the active project on import and loads native modules |

An app imports `orc-state/client` only. It needs Node ≥ 22.13 for `listProjects` (Node 24 prints an `ExperimentalWarning` on the first call).

```ts
import { listProjects, ControlClient } from 'orc-state/client';

for (const project of listProjects()) {
  if (!project.repo_present || !project.coordinator_running) continue; // nothing to talk to
  const client = new ControlClient(project.state_dir);
  const status = await client.status();
}
```

- `listProjects({ env? })` reads `registry.db` read-only from the data home (`ORC_DATA_HOME` or the platform default); it creates nothing and returns `[]` when there is no registry.
- Each entry has `repo_present` (the checkout still exists) and `control_socket`, which is non-null only while the coordinator runs: a stopped coordinator leaves a stale `control.json` that the entry hides.
- `new ControlClient(state_dir)` finds the socket and bearer token in the state directory; `{ socketPath }` overrides the socket only. The client never reads `ORC_CONTROL_SOCKET`. `state_dir` must be absolute (a `TypeError` otherwise), so an empty or relative path cannot resolve against the app's working directory.
- Check `health()` (`version`, `build_id`) against the installed package after an upgrade. `health()` works whatever protocol version the client speaks and reports the coordinator's `protocol_versions: [min, max]`; any other call to a coordinator outside the client's range fails with `ControlError('unsupported_protocol_version')` naming both ranges.

## Cancellation and timeouts

Every `ControlClient` method takes `{ signal?, timeoutMs? }` as its last argument:

```ts
const abort = new AbortController();
const status = await client.status({}, { signal: abort.signal, timeoutMs: 2_000 });
```

| Call | Default timeout |
|---|---|
| Any request | The client's `timeoutMs` (10 s; set it in `new ControlClient(dir, { timeoutMs })`) |
| `importTasks`, `importPlans` | At least 5 min: bodies up to 32 MiB |
| `subscribe`, `streamTerminal` | None once open (a stream silent for `streamIdleMs`, 30 s, fails with `unavailable`); `timeoutMs` bounds only opening it, default `streamIdleMs` |

- Abort destroys the request and rejects with `ControlError` code `aborted`; a stream ends without an error instead. `timeoutMs: 0` disables the timeout.
- A timeout rejects with code `timeout`. The coordinator may already have applied the request, so retry only reads or idempotent calls.
- An error response that is not JSON (a proxy page, an empty body) is a `ControlError` (code `internal`) with the HTTP status and a short excerpt, never a `SyntaxError`.
- `inputTerminal` calls on one client to one terminal are sent one at a time in call order. A retried input (after `busy`) joins the back of the queue, so queue nothing else until the retry settles ([terminal-streaming.md](terminal-streaming.md)).

## Watching every project

`ProjectWatcher` does the `listProjects()` + one `ControlClient` per project + status + event stream loop for you, including coordinator restarts and registry changes. A cockpit or desktop app consumes its updates instead of managing connections.

```ts
import { ProjectWatcher } from 'orc-state/client';

const watcher = new ProjectWatcher();
const unsubscribe = watcher.onUpdate((update) => {
  switch (update.type) {
    case 'added': case 'removed': break;                  // the registry gained or lost a project
    case 'connection': render(update.project_id, update.connection, update.error); break;
    case 'status': renderStatus(update.project_id, update.status); break; // StatusView, agents carry `attention`
    case 'event': append(update.project_id, update.row); break;            // EventRow, in seq order
    case 'registry_error': warn(update.error); break;      // e.g. RegistrySchemaError; the watched set is kept
  }
});
watcher.start();
// later
await watcher.stop(); // closes every stream and timer
```

| `connection` | Meaning | Next |
|---|---|---|
| `connecting` | Added with a coordinator registered as running; first connect not settled | `running`, `unreachable` or `incompatible` |
| `running` | Status read and event stream open | |
| `stopped` | No coordinator runs (the registry's liveness check) | Waits for the registry poll to see one start |
| `unreachable` | A coordinator is registered as running but refuses or drops the connection, or closed its stream | Retries with backoff: `initialMs` (500) doubling up to `maxMs` (30 000); reset once connected |
| `incompatible` | Its `protocol_versions` do not overlap the client's (`error` names both ranges) | Retries every `maxMs`, e.g. after the coordinator is upgraded |

- **Events.** The first connect starts at the status view's `cursor`: earlier events are in `status.recentEvents`, not replayed. Every reconnect resumes the stream from the last delivered `seq`, so a restart neither repeats nor skips events; a row at or below the cursor is dropped.
- **Status.** Read on every connect, then refreshed after events: the events of one `statusDebounceMs` window (250 ms) share one `GET /v1/status`, so the watcher never polls status on a timer. A failed refresh keeps the previous view; the stream reports connection loss.
- **Registry.** Re-read every `registryPollMs` (2 s) and after a stream ends: new projects are `added`, unregistered ones `removed` (their streams closed), and a coordinator's start or stop wakes its project at once. A project whose `state_dir` changed is removed and added again. A failed read keeps the watched set and emits `registry_error` once per distinct error (a persistent `RegistrySchemaError` is reported once, until a read succeeds). A project whose client cannot be created (`createClient` threw, e.g. a relative `state_dir`) stays `unreachable` with that error and is not retried.
- **Testing.** `listProjects`, `createClient` (anything with `health`, `status`, `subscribe`) and `timers` (`setTimeout`/`clearTimeout`) are injectable; `clientOptions` reaches the default `ControlClient`.
- A listener that throws does not stop the watcher; its error is rethrown in a microtask (an uncaught exception, as from a throwing event listener).

## Showing an agent's terminal

Two ways:

- **Through the coordinator**: `ControlClient.openAgentTerminal` / `streamTerminal` / `inputTerminal` (the terminal API, with its input lease); needs a running coordinator ([terminal-streaming.md](terminal-streaming.md)).
- **Directly on tmux**, as the cockpit does: the status view's `master`, `worker_capacity.slots[]` and `scouts[]` carry `tmux_socket` and `tmux_session` (both `null` for a session that is not on tmux, such as `app:`), and `tmuxSessionTarget(project.state_dir, agentId)` computes the same target without a coordinator (the master's id is `master`). Attach with `tmux -L <tmux_socket> -C attach-session -f ignore-size -t =<tmux_session>`: never resize a worker's or scout's window, which the agent's provider CLI renders for its own size. The cockpit's handling of late attach, hidden tabs, keys, pastes and the mouse: [terminal-streaming.md → The cockpit's path](terminal-streaming.md#the-cockpits-path-libcockpit2).

## Keying workers

Key a worker's work by `run_id`. Agent names are reused across runs, and one `session_id` survives a resume (only `generation` goes up), so a view keyed by either mixes different runs or misses a restart. `session_id` + `generation` identify one live process; run events carry both in `payload` when the run has a session. Details: [contracts.md → Events](contracts.md#events).

## Always name the project

An app launched from a Dock or launcher has an unrelated working directory and an inherited environment, so it must never let orc pick a project for it. Nothing in `orc-state/client` selects one: `listProjects()` lists them all and `ControlClient` talks to the state directory it is given. Use the `state_dir` from `listProjects()` for the client and `--project=<id>` for every `orc` process. `orc status --json` reports `project.selected_by`; anything other than `flag` in a CLI call the app made means it forgot `--project`.

## Passing `--project`

When the app runs the `orc` CLI itself (for example `orc start-session`, `orc project task create`), pass `--project=<id>` with the `id` from `listProjects()` on every call. It beats every other selector, and an inherited `ORC_STATE_DIR` is ignored; a GUI has no meaningful working directory to resolve a project from. See [configuration.md → Project selection](configuration.md#project-selection).

## Environment for a GUI-launched app

An app started from a dock, launcher or service manager does not inherit a login shell's `PATH`. The coordinator it starts (and every session that coordinator launches) resolves binaries from the environment it was given. Set explicitly:

| Variable | Why |
|---|---|
| `PATH` | Must contain `orc`, `node` ≥ 24, `git`, and the directories of the provider CLIs (`claude`, `codex`, `gemini`). Add the npm global bin and `~/.local/bin` yourself; Homebrew's `/opt/homebrew/bin` is absent from a GUI `PATH` on macOS |
| `ORC_TMUX_BIN` | Absolute path to tmux ≥ 3.2 when it is not on that `PATH`. The master and every worker run in tmux |
| `ORC_CODEX_BINARY` | Absolute path to `codex` for the structured Codex runtime when it is not on `PATH` |
| `ORC_DATA_HOME` | Only to use a data home other than the platform default; set it identically for `listProjects` and for every `orc` process the app starts |
| Provider credentials | Whatever the provider CLI needs (login state, API key variables); a GUI process does not see shell-profile exports |

Run `orc doctor --project=<id>` with the same environment to confirm tmux, the providers and the project resolve.

## Upgrading

1. Install the new package (`npm i -g orc-state@next`, or rebuild).
2. Restart the coordinator; it keeps the code it started with: `orc coordinator restart --project=<id>` (runs and live worker sessions are kept and adopted). See [getting-started.md → Upgrading while a coordinator runs](getting-started.md#upgrading-while-a-coordinator-runs).
3. Re-read `health()`: `version` and `build_id` should equal the installed package.
4. `listProjects()` throws `RegistrySchemaError` (`{ version, supportedVersion }`) when a newer orc wrote `registry.db`: update the app's `orc-state` dependency before using it again.
