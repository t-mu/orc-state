# orc-state

[![CI](https://github.com/t-mu/orc-state/actions/workflows/ci.yml/badge.svg)](https://github.com/t-mu/orc-state/actions/workflows/ci.yml)

Spawn, command, and coordinate.

A provider-agnostic orchestration runtime for autonomous coding agents: it dispatches tasks to AI workers, manages their lifecycle and merges the results. Runs locally; state lives in SQLite and files outside your repository, served to agents over a local control socket.

- **Provider-agnostic**: Claude, Codex, Gemini, mixed freely in one session.
- **No infrastructure**: no servers or external services.
- **Parallel**: each worker runs in its own git worktree.
- **Terminal-native**: live dashboard and full CLI control.

## Requirements

| Requirement | Version |
|---|---|
| Node.js | 24+ |
| tmux | 3.2+ |
| Git | any recent |
| Provider CLI | [Claude](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) or [Gemini](https://github.com/google/gemini-cli), authenticated |

Platforms: macOS and Linux. Windows via WSL only.

## Quick start

```bash
npm install -g orc-state
orc project add ~/code/my-project   # register the repository
cd ~/code/my-project
orc init                            # pick providers
orc install --global --provider=claude   # optional: skills and agents
orc start-session                   # coordinator + master session
```

- Detach from the master with `Ctrl-b d` or by closing the terminal; it keeps running.
- Run `orc start-session` again to reattach to the same master.
- `orc kill-all` stops the coordinator and the master, resets active tasks and removes run worktrees.

Details: [Getting started](./docs/getting-started.md). Upgrading with a coordinator running: [restart it](./docs/getting-started.md#upgrading-while-a-coordinator-runs). Upgrading from 0.3: [clean break](./docs/getting-started.md#upgrading-from-03).

## How it works

- You plan with the master agent; it creates tasks in the project's task store.
- The coordinator dispatches each task to a worker in an isolated worktree, then merges it.
- You monitor and unblock through the master or `orc status` / `orc watch`.

## Documentation

- [Getting started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [CLI reference](./docs/cli.md)
- [Contracts](./docs/contracts.md)
- [Embedding orc](./docs/embedding.md)
- [Memory](./docs/memory.md)
- [Adapters](./docs/adapters.md)
- [Testing](./docs/testing.md)
- [Recovery](./docs/recovery.md)

## License

MIT
