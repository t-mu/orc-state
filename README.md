# orc-state

[![CI](https://github.com/t-mu/orc-state/actions/workflows/ci.yml/badge.svg)](https://github.com/t-mu/orc-state/actions/workflows/ci.yml)

Spawn, command, and coordinate.

A provider-agnostic orchestration framework for autonomous coding agents.
Dispatches tasks to AI workers, manages their lifecycle, and merges results —
all locally in your repo, backed by nothing but files.

- **Provider-agnostic** — Claude, Codex, Gemini. Same orchestration, any model.
- **Cross-provider** — mix and match agent providers freely in the same session.
- **Zero infrastructure** — no servers, no external services. Everything runs locally in your repo.
- **Parallel autonomous agents** — multiple agents working in isolated worktrees simultaneously.
- **Terminal-native** — live dashboard, full CLI control, zero context switching.

## Quick start

Requires Node.js 24+ and at least one supported provider CLI
([Claude](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://github.com/openai/codex),
or [Gemini](https://github.com/google/gemini-cli)).

```bash
npm install -g orc-state
cd my-project
orc init                    # pick providers, install skills/agents/MCP
orc start-session           # start orchestrating
```

`orc init` walks you through provider selection and installs the skills,
agent definitions, and MCP configuration your providers need. After init,
`orc start-session` reads from your config — no flags required.

`orc start-session` starts the coordinator in the background and opens a
master agent session in your terminal. If a coordinator is already running,
it reuses it. You pick the provider for your master session at init time
(or override with `--provider=<name>`).

## How it works

You're now in a conversation with the master agent. Start planning the work
— discuss scope, break it into units, and ask the master to create tasks.
It writes task specs to `backlog/*.md`.

Once tasks are in the backlog, the coordinator dispatches them to worker
agents that execute each task in an isolated git worktree. You can monitor
progress, intervene on blockers, and review results — all through the
master session.

For deeper work, you can also write task specs directly in `backlog/*.md` —
the coordinator picks them up on the next tick. See
[Concepts & terminology](./docs/concepts.md) and
[Architecture overview](./docs/architecture.md) for the mental model.

## Documentation

- [Getting started](./docs/getting-started.md)
- [Concepts & terminology](./docs/concepts.md)
- [Architecture overview](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [CLI reference](./docs/cli.md)
- [Memory system](./docs/memory.md)
- [Writing custom adapters](./docs/adapters.md)
- [Testing](./docs/testing.md)
- [Contracts & invariants](./docs/contracts.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Recovery guide](./docs/recovery.md)

## License

MIT
