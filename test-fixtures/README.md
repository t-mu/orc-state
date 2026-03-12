# PTY Test Fixtures

Deterministic local provider CLI fixture used by orchestration integration/e2e tests.

## Protocol

Startup marker:
- `FIXTURE_READY provider=<provider>`

Commands (line-delimited stdin):
- `PING` => `FIXTURE_PONG`
- `EXIT` => `FIXTURE_BYE` and exits code `0`
- any other line `X` => `FIXTURE_ECHO <X>`

## Environment switches

- `FAKE_PROVIDER_CRASH_ON_START=1`
  - writes `FIXTURE_CRASH_ON_START` to stderr
  - exits code `42`

- `FAKE_PROVIDER_HEARTBEAT_MS=<n>`
  - emits `FIXTURE_HEARTBEAT` every `<n>` milliseconds

## PATH usage in tests

Prepend fixture wrappers to PATH:

```bash
PATH="$(pwd)/orchestrator/test-fixtures/bin:$PATH"
```

Available wrappers:
- `claude`
- `codex`
- `gemini`

All wrappers dispatch into `fake-provider-cli.mjs` with a provider-specific argument.

## PTY integration test modes

Default behavior in integration tests:
- PTY-dependent suites skip automatically when PTY support is unavailable.

Strict mode (CI for PTY-capable runners):

```bash
ORC_STRICT_PTY_TESTS=1 npx vitest run -c orchestrator/vitest.integration.config.mjs
```

When strict mode is enabled, PTY support probe failure is treated as a test failure.

Local override (use only when you know PTY is available):

```bash
ORC_PTY_AVAILABLE=1 npx vitest run -c orchestrator/vitest.integration.config.mjs
```

This bypasses probe failures and forces PTY suites to execute.
