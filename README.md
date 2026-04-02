# orc-state

Spawn, command, and coordinate.

- **Provider-agnostic** — Claude, Codex, Gemini. Same orchestration, any model.
- **Cross-provider** — mix and match agent providers freely in the same session.
- **Zero infrastructure** — no servers, no external services. Everything runs locally in your repo.
- **Parallel autonomous agents** — multiple agents working in isolated worktrees simultaneously.
- **Terminal-native** — live dashboard, full CLI control, zero context switching.

<!-- TODO: screenshot or GIF of orc watch TUI -->

## Getting started

Requires Node.js 24+

```bash
npm install -g orc-state
orc start-session --provider=claude  # or codex, gemini
```

See [full documentation](./docs/) for configuration and usage.

## Documentation

- [Getting started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [CLI reference](./docs/cli.md)
- [Writing custom adapters](./docs/adapters.md)
- [Contracts & invariants](./docs/contracts.md)
- [Troubleshooting](./docs/troubleshooting.md)

## Disclaimer

The system was 100% vibecoded by the system itself. User discretion advised.

## License

MIT
