# Getting started

## Prerequisites

- Node.js 24+
- Git
- tmux 3.2 or newer: the master and every worker run in orc's tmux server; `orc doctor` and `orc start-session` check it
- At least one provider CLI installed and authenticated: Claude Code, Codex CLI or Gemini CLI ([recovery.md](recovery.md) for install/auth problems)

## Install

```bash
npm install -g orc-state
orc project add ~/code/my-project            # register the repo; state lives outside it
cd ~/code/my-project
orc init                                     # pick providers (non-TTY: --provider=claude,codex)
orc install --global --provider=claude,codex # optional: skills and agents for your user
orc doctor                                   # verify
```

- `orc init` records provider settings in the registry; it writes nothing into the repository.
- `orc start-session` wires the orchestrator MCP server into the master itself.

## Start a session

```bash
orc start-session
```

- **Coordinator** (background): dispatches tasks, probes worker processes, merges results.
- **Master**: your interactive session. It runs in orc's private tmux server.
- **Cockpit**: what `start-session` attaches this terminal to (tmux is required). A tmux session on a per-user server of its own (`tmux -L orc-cockpit`), with one tab per project: the master's pane, focused, and the dashboard (`orc watch`) beside it.

### Getting around

The cockpit claims one key, its prefix `Ctrl-]`. Every other key, `Ctrl-b` included, reaches the focused pane, and the mouse behaves as in a plain terminal.

| Keys | Does |
|---|---|
| `Ctrl-] o` | switch between the master and the dashboard pane |
| `Ctrl-] n` / `Ctrl-] p` | next / previous tab (project tabs and agent tabs) |
| `Ctrl-] d` | detach |
| `Ctrl-] &` | close the current tab; never stops its master or agent |
| `Ctrl-]` `Ctrl-]` | send `Ctrl-]` to the pane |

In the dashboard pane:

- `↑`/`↓` select an agent. An agent that needs you shows a badge (`QUESTION`, `PERMISSION`, `STALLED`, `NO PROGRESS`), with the question below it, and is listed first.
- Enter on a worker or scout opens its live terminal in a tab next to the project's tab (`orc terminal <agent_id> --write`), or switches to that tab. Closing the tab ends only the stream; the agent keeps running. Enter on a master switches to its project's tab.
- `t` opens the task explorer: the project's tasks and their specs, read-only.

The dashboard only shows a question. Answer it through the master, or with `orc run-input-respond`.

### Detach and reattach

- Detach with `Ctrl-] d`, the master's `Ctrl-b d`, or by closing the terminal. The cockpit, the master, the workers and the coordinator keep running, and the master's MCP tools keep working.
- Run `orc start-session` again to reattach. A live master is reattached with no prompts and no state reset.
- Run it in another registered project to add that project's tab to the same cockpit. From a shell inside the cockpit it only switches to the tab.
- If the master process has died, its pane says so and waits; `orc start-session` starts it again. A Claude master resumes its recorded conversation (`--resume`); otherwise it starts fresh.
- `orc start-session --no-cockpit` attaches straight to the master instead. It also works from inside your own tmux session, as a nested client.
- `tmux -L orc-cockpit kill-server` closes the cockpit without stopping anything; `orc kill-all` stops the master and revokes its credential.

Providers come from the project settings (`orc project config list`); a task's `required_provider` overrides the worker provider.

## Create a task

Ask the master (it calls `create_task`), or use the CLI:

```bash
orc project task create --feature=general --title="Add request logging" --body-file="$HOME"/specs/add-logging.md
orc project task import ~/specs/add-logging.md   # or import a Markdown spec
```

Task body format: [task-template.md](task-template.md).

## Dispatch

Automatic: each tick the coordinator claims an eligible `todo` task, creates a worktree and starts a worker when `worker_pool.max_workers` allows. To force a dispatch: `orc delegate --task-ref=<feature/task>`.

## Monitor

The cockpit's dashboard is the live view. From any other shell:

```bash
orc status                 # one-shot summary
orc watch                  # the cockpit dashboard on its own (Enter opens terminals only in the cockpit)
orc events                 # recent events
orc terminal <agent-id>    # an agent's live terminal, read-only (--write for input)
orc doctor                 # health check
```

## Upgrading while a coordinator runs

A coordinator keeps the code it started with. After `npm i -g orc-state@next` or `npm run build`, it is out of date until restarted:

| Step | Command |
|---|---|
| See it | `orc doctor` warns when the running coordinator's `version` or `build_id` (from `/v1/health`) differs from the code on disk |
| Restart | `orc coordinator restart` (MCP `restart_coordinator`), or `orc start-session --restart-stale` when starting the master; runs and live sessions are kept and adopted |

Without `--restart-stale`, `orc start-session` reuses the running coordinator and prints the same warning. An app checks `version`/`build_id` from `/v1/health` against the installed package.

## Upgrading from 0.3

1.0 cannot migrate 0.3 state. Start the project again:

| Step | Command |
|---|---|
| Register the repository | `orc project add <repo-path>` |
| Pick providers (from the repository) | `cd <repo-path> && orc init` |
| Re-create open tasks | `orc project task create ...` or `orc project task import <spec.md>` |
| Verify | `orc doctor` |

- 0.3 kept state in `.orc-state/` inside the repository. 1.0 does not read it, and you can delete it. `orc doctor` warns while it is still there.
- 0.3 run history, claims and events are not carried over.

## Next

- [Configuration](configuration.md)
- [CLI reference](cli.md)
- [Embedding orc in an app](embedding.md)
- [Architecture](architecture.md)
