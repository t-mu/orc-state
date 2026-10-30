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
orc project add ~/code/my-project   # register the repository (or: orc project migrate <old-root> --execute)
cd ~/code/my-project
orc init                            # pick providers; stored in the project registry
orc install --global --skip-mcp --provider=claude   # optional: skills and agents for your user
orc start-session                   # start orchestrating
```

`orc init` walks you through provider selection and records it in the
project registry; it writes nothing into your repository. All orc state lives
outside the repository, in the project's state directory. After init,
`orc start-session` reads the project settings — no flags required. It wires
the orchestrator MCP server into the master session itself.

Legacy `.orc-state` installations (state and `backlog/` inside the repository)
no longer run; migrate one with `orc project migrate <root> --execute`.

`orc start-session` starts the coordinator in the background and opens a
master agent session in your terminal. If a coordinator is already running,
it reuses it. You pick the provider for your master session at init time
(or override with `--provider=<name>`).

## How it works

You're now in a conversation with the master agent. Start planning the work
— discuss scope, break it into units, and ask the master to create tasks.
It stores them in the project's task store (`create_task`); no file is written
to your repository.

Once tasks are in the backlog, the coordinator dispatches them to worker
agents that execute each task in an isolated git worktree. You can monitor
progress, intervene on blockers, and review results — all through the
master session.

For deeper work, you can also author tasks yourself with
`orc project task create|edit`, or import Markdown specs with
`orc project task import <path>`. See
[Concepts & terminology](./docs/concepts.md) and
[Architecture overview](./docs/architecture.md) for the mental model.

## Documentation

- [Getting started](./docs/getting-started.md)
- [Concepts & terminology](./docs/concepts.md)
- [Architecture overview](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Sibling mode (retired)](./docs/sibling-mode.md) — migrating an old sibling orchestration home
- [CLI reference](./docs/cli.md)
- [Memory system](./docs/memory.md)
- [Writing custom adapters](./docs/adapters.md)
- [Testing](./docs/testing.md)
- [Contracts & invariants](./docs/contracts.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Recovery guide](./docs/recovery.md)

## License

MIT
