# Test fixtures

`fake-provider-cli.ts`: deterministic provider CLI for PTY integration and e2e tests. `bin/claude`, `bin/codex`, `bin/gemini` wrap it with the provider name; prepend them to `PATH`:

```bash
PATH="$(pwd)/test-fixtures/bin:$PATH"
```

| Input / env | Output |
|-------------|--------|
| start | `FIXTURE_READY provider=<provider>`, `FIXTURE_CWD <cwd>`, `FIXTURE_STATE_DIR <ORC_STATE_DIR>` |
| `PING` | `FIXTURE_PONG` |
| `TUI_REPORT` | redraws a scout report TUI-style (`tuiScoutReport.ts`) |
| `EXIT` | `FIXTURE_BYE`, exit 0 |
| any other line `X` | `FIXTURE_ECHO X` |
| `FAKE_PROVIDER_CRASH_ON_START=1` | `FIXTURE_CRASH_ON_START` on stderr, exit 42 |
| `FAKE_PROVIDER_HEARTBEAT_MS=<n>` | `FIXTURE_HEARTBEAT` every `<n>` ms |

Other fixtures: `fake-codex-app-server.ts` (Codex app-server), `fakeCoordinator.ts`, `projectCli.ts`, `projectModeProbe.ts`, `stateHelpers.ts`.

PTY suites skip when `ptySupport.ts` finds no PTY; `RUN_STRICT_PTY_TESTS=1` / `RUN_PTY_AVAILABLE=1` change that ([docs/testing.md](../docs/testing.md#env-switches)).
