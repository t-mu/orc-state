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
- **Cockpit**: what `start-session` attaches this terminal to (tmux is required). A tmux session on a per-user server of its own (`tmux -L orc-cockpit`), shown as one window: the sidebar (`orc watch`) on the left, a tab bar at the top listing the projects and the active project's tabs, and below it the slot, showing the active tab: at first the master, focused.

### Getting around

The cockpit claims only its own keys, all function keys by default, so they work on any keyboard layout without Option/Alt. Every other key, `Ctrl-b` included, reaches the focused pane. Mouse mode is on: click a pane to focus it; a program that uses the mouse, such as the master, still gets its clicks.

| Keys | Does |
|---|---|
| `F1` … `F9` (or `F12 1` … `F12 9`) | select tab 1–9 of the active project (tab 1 is its master) |
| `F10` | focus the sidebar |
| `F11` | show the next agent that needs you (its project and tab) |
| `F12 o` | switch between the slot, the sidebar and the tab bar |
| `F12 n` / `F12 p` | next / previous tab of the active project |
| `F12 N` / `F12 P` | next / previous project, its tabs as you left them |
| `F12 d` | detach |
| `F12 &` | close the current agent tab; the master tab stays; never stops a master or agent |
| `F12 t` | show the task explorer of the active project in the slot; Esc or `q` in its list closes it and the slot shows the tab you had |
| `F12` `F12` | send `F12` to the pane |

`F12` is the prefix: press it, release, then the key. Change the prefix and the direct keys with `ORC_COCKPIT_PREFIX` and `ORC_COCKPIT_KEYS` ([configuration.md → Cockpit keys](configuration.md#cockpit-keys)); `orc start-session` applies them to a running cockpit too.

In the sidebar (`F10` focuses it):

- **Status**: the active project's coordinator, its workers used/total, and how many agents need you across projects.
- **Projects**: every project with its state and `!N` when N of its agents need you; `▸` marks the active one.
- **Agents** of the active project, workers and scouts: name, phase and run time, then what it is doing. An agent that needs you shows a badge (`QUESTION`, `PERMISSION`, `STALLED`, `NO PROGRESS`) with the question or reason below it, and is listed first.
- `↑`/`↓` move within a box, `Tab` switches between Projects and Agents, Enter (or a click) selects, `Esc` goes back to the slot. Selecting a project shows it in the slot (`orc cockpit project`); selecting an agent opens its live terminal in a tab of its project (`orc terminal <agent_id> --write`), or shows that tab again; the stream stays open while other tabs are shown. Closing the tab ends only the stream; the agent keeps running.
- `F12 t` shows the task explorer in the slot: the active project's tasks and their specs, read-only (see the keys above).

The sidebar only shows a question. Answer it through the master, or with `orc run-input-respond`.

### Detach and reattach

- Detach with `F12 d`, the master's `Ctrl-b d`, or by closing the terminal. The cockpit, the master, the workers and the coordinator keep running, and the master's MCP tools keep working.
- Run `orc start-session` again to reattach. A live master is reattached with no prompts and no state reset.
- Run it in another registered project to add that project to the same cockpit. Back in a project already there, it shows the tab you left it on. From a shell inside the cockpit it only switches the slot.
- From a shell in the cockpit, `orc cockpit project <project_id>` shows a registered project that is not in it: the slot says how to start it. Nothing is started for you.
- A cockpit from an older orc (a window per project) is rebuilt in this layout on the next `orc start-session`; no master or agent is stopped.
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

The cockpit's sidebar is the live view. From any other shell:

```bash
orc status                 # one-shot summary
orc watch                  # the cockpit sidebar on its own (terminals open only in the cockpit)
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
