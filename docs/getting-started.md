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
- **Cockpit**: what `start-session` runs in this terminal. It draws the whole terminal itself: a header row at the top (the project, the `tasks` entry and the attention count), a footer row at the bottom (the mode and the cockpit's keys), the sidebar on the left, a tab bar with the active project's tabs, and below it the slot, showing the active tab: at first the master, which has the keys. Each project has its own tabs: its master first, then the agent terminals you open, in opening order. The master is reached directly on orc's tmux server, so its tab works while the coordinator is stopped.

### Getting around

The cockpit claims only its own keys, function keys and `Ctrl-q` by default, so they work on any keyboard layout without Option/Alt. Every other key, `Ctrl-b` included, reaches the active tab, and a paste arrives there as one paste. Click a tab in the tab bar to show it, its `×` to close an agent tab, and a project or an agent in the sidebar to open it; what you click takes the keys. In the slot, a program that uses the mouse gets it; otherwise the wheel scrolls the tab's scrollback and a drag selects text, copied to the clipboard on release (hold Shift to select over a program that uses the mouse).

| Keys | Does |
|---|---|
| `F1` … `F9` (or `F12 1` … `F12 9`) | select tab 1–9 of the active project (tab 1 is its master) |
| `F10` (or `F12 o`) | give the sidebar the keys; `Esc` (or `F12 o` again) gives them back to the tab |
| `F11` | show the next agent that needs you (its project and tab) |
| `F12 n` / `F12 p` | next / previous tab of the active project |
| `F12 N` / `F12 P` | next / previous project, its tabs as you left them |
| `Ctrl-q` or `F12 d` | quit the cockpit; nothing else stops |
| `F12 &` | close the current agent tab; the master tab stays; never stops a master or agent |
| `F12 t` | open the task explorer of the active project as a tab; Esc or `q` in its list closes it and shows the tab you had |
| `F12` `F12` | send `F12` to the tab |

`F12` is the prefix: press it, release, then the key. Change the prefix and the other keys with `ORC_COCKPIT_PREFIX` and `ORC_COCKPIT_KEYS` ([configuration.md → Cockpit keys](configuration.md#cockpit-keys)).

In the sidebar (`F10` gives it the keys):

- **Projects**: every registered project with its state and `!N` when N of its agents need you; `▸` marks the active one. Opening another project shows it with the tabs and the active tab you left it on; one that is not running shows the command that starts it (the cockpit starts nothing itself).
- **Project** (titled with the active project): its coordinator, its workers used/total, its open tasks, and a `[ SETTINGS ]` button (settings are not available yet).
- **Agents** of the active project, workers and scouts: name, phase and run time, then what it is doing. An agent that needs you shows a badge (`QUESTION`, `PERMISSION`, `STALLED`, `NO PROGRESS`) with the question or reason below it, and is listed first.
- `↑`/`↓` (or `j`/`k`) move within a box, `Tab` and `Shift-Tab` cycle the Projects, Project and Agents cards, `Enter` (or a click) opens and gives the opened tab the keys, `Esc` goes back to the tab. Opening an agent shows its live terminal in a tab of its project, or that tab again. The tab opens in view mode: no key reaches the agent, and `q`, `Esc`, `Ctrl-D`, `Ctrl-C` or `Ctrl-]` closes the tab at once. `i` switches to typing mode (every key goes to the agent) until `Ctrl-]` or you leave the tab. A line in the sidebar shows the current mode and its keys. Closing the tab ends only the view; the agent keeps running.

The tab bar shows the active project's tabs, the active one highlighted. An agent tab whose agent needs you carries the same badge, and `‹ N` / `N ›` count the tabs that do not fit.

The sidebar and the tab bar only show a question. Answer it through the master, or with `orc run-input-respond`; the badges clear once it is answered.

### Quit and come back

- Quit with `Ctrl-q` or `F12 d`, or close the terminal. The master, the workers and the coordinator keep running, and the master's MCP tools keep working.
- Run `orc start-session` again to reopen the cockpit. A live master is reattached with no prompts and no state reset, and the cockpit opens with the tabs it had.
- `orc cockpit` opens the cockpit on the current project without starting a coordinator or a master; it moves between terminals and adds projects as `orc start-session` does.
- One cockpit runs at a time. Run `orc start-session` in another terminal and the cockpit moves there: the old one exits and says the cockpit moved to another terminal.
- Run it in another registered project, from another terminal, and the cockpit moves there with that project shown; the other projects and their tabs stay in it (quit the cockpit first to run it in the same terminal). Back in a project already there, it shows the tab you left it on.
- From a shell inside orc's tmux sessions, such as the master's, `orc start-session` opens no second cockpit: it adds the project to the running cockpit, which shows it.
- If the master process has died, its tab says so with the command that starts it; `orc start-session` starts it again. A Claude master resumes its recorded conversation (`--resume`); otherwise it starts fresh.
- `orc start-session --no-cockpit` attaches straight to the master instead (`Ctrl-b d` detaches). It also works from inside your own tmux session, as a nested client.
- A cockpit that hangs: `orc start-session` from another terminal moves it there while the hung one still handles its wake-up signal; a truly stuck one does not exit, so end it with `kill <pid>` (the pid is in its lock file). See [recovery.md → Cockpit](recovery.md#cockpit). `orc kill-all` stops the master and revokes its credential.

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
