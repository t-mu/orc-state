# orc-state

[![CI](https://github.com/t-mu/orc-state/actions/workflows/ci.yml/badge.svg)](https://github.com/t-mu/orc-state/actions/workflows/ci.yml)

Spawn, command, and coordinate.

A provider-agnostic orchestration runtime for autonomous coding agents: it dispatches tasks to AI workers, manages their lifecycle and merges the results. Runs locally; state lives in SQLite and files outside your repository, served to agents over a local control socket.

- **Provider-agnostic**: Claude, Codex, Gemini, mixed freely in one session.
- **No infrastructure**: no servers or external services.
- **Parallel**: each worker runs in its own git worktree.
- **Terminal-native**: live dashboard and full CLI control.

## Quick start

Requires Node.js 24+ and a provider CLI ([Claude](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) or [Gemini](https://github.com/google/gemini-cli)).

```bash
npm install -g orc-state
orc project add ~/code/my-project   # register the repository
cd ~/code/my-project
orc init                            # pick providers
orc install --global --provider=claude   # optional: skills and agents
orc start-session                   # coordinator + master session
```

Details: [Getting started](./docs/getting-started.md).

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
- [Memory](./docs/memory.md)
- [Adapters](./docs/adapters.md)
- [Testing](./docs/testing.md)
- [Recovery](./docs/recovery.md)

## License

MIT
