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
- **Master**: your interactive session. It runs in orc's private tmux server and `start-session` attaches this terminal to it.

`start-session` creates the master or reattaches to it (tmux is required):

- Detach with `Ctrl-b d`, or close the terminal. The master keeps running and its MCP tools keep working.
- Run `orc start-session` again to reattach to the same master. A live master is reattached with no prompts and no state reset.
- If the master process has died, `start-session` starts it again. A Claude master resumes its recorded conversation (`--resume`); otherwise it starts fresh.
- It works from inside your own tmux session too, as a nested client.
- `orc kill-all` stops the master and revokes its credential.

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

```bash
orc status                 # one-shot summary
orc watch                  # live dashboard
orc events-tail            # recent events
orc attach <agent-id>      # worker's tmux terminal, read-only (--write for input, Ctrl-b d detaches)
orc doctor                 # health check
```

## Next

- [Configuration](configuration.md)
- [CLI reference](cli.md)
- [Architecture](architecture.md)
