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
orc init                              # first-time setup
orc start-session --provider=claude   # start orchestrating
```

That's it — the coordinator picks up tasks from your backlog and dispatches
them to workers automatically.

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
