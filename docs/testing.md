# Testing

## Suites

| Command | Config | Runs |
|---------|--------|------|
| `npm test` | `vitest.config.mjs` | `pretest` (`tsc` check + test configs, `eslint .`), then every `*.test.ts` except `e2e/`, `e2e-real/` |
| `npm run test:e2e` | `vitest.e2e.config.mjs` | `e2e/` with fixture provider CLIs (`test-fixtures/`) |
| `npm run test:real-providers` | `vitest.real-providers.config.mjs` | `e2e-real/` against real `claude` / `codex` (opt-in) |
| `npx vitest run -c vitest.integration.config.mjs` | `vitest.integration.config.mjs` | only `*.integration.test.ts` (no npm script; `npm test` runs them too) |

Every config:
- strips inherited `ORC_*` variables (`vitest.orcEnv.mjs`, guarded by `vitest.orcEnv.test.ts`), so the suite is safe inside a worker session; tests get only `ORC_DATA_HOME` (an empty test home) and, except real-providers, `ORC_SESSION_TRANSPORT=pty`;
- gives tests a private `TMUX_TMPDIR` (`vitest.tmuxTmpdir.mjs` globalSetup).

Command-line switches therefore use a `RUN_` prefix; an `ORC_*` switch is stripped.

## Env switches

| Variable | Effect |
|----------|--------|
| `RUN_REAL_PROVIDERS=1` | enables `e2e-real/` (Claude and Codex) |
| `RUN_REAL_PROVIDERS_CODEX=1` | enables only the Codex real-provider test |
| `RUN_TMUX_SMOKE=1` | real tmux terminal smoke (`lib/terminalBroker.test.ts`) |
| `RUN_DOCKER_SMOKE=1` | Docker project image smoke (`docker/project/project.integration.test.ts`) |
| `RUN_STRICT_PTY_TESTS=1` | a failed PTY support probe fails the run instead of skipping PTY suites (CI on PTY-capable runners) |
| `RUN_PTY_AVAILABLE=1` | skip the probe and force PTY suites to run |

## Real-provider suite

```bash
RUN_REAL_PROVIDERS=1 npm run test:real-providers
RUN_REAL_PROVIDERS_CODEX=1 npm run test:real-providers          # Codex only
npm run test:real-providers -- e2e-real/harness/harness.test.ts  # harness only, no provider or switch needed
```

- Serial (`fileParallelism: false`, `singleThread: true`); `testTimeout` 30 min.
- Each test: temp root with a clean git repo and temp `ORC_DATA_HOME`, `orc project add`, `worker_pool.max_workers=1`, two dependent tasks, real coordinator, asserts `run_started` per run and that all paths stay in the temp root.
- Per-task / overall timeout: Claude 10 / 25 min, Codex 15 / 35 min.
- Tests skip when the binary is missing, PTY is unavailable, or the binary does not spawn. Auth is not checked: log in first ([recovery.md](./recovery.md#providers)).
- Not covered: `start-session`/master, input requests, sandbox mode, concurrent workers, provider output text.

## Provider protocol smoke

Real inference, not part of any suite; uses the CLI's existing login and strips API-key env from the child:

```bash
ORC_CODEX_SMOKE_BINARY=<path to codex> node scripts/vnext-provider-smoke.ts codex
ORC_CLAUDE_SMOKE_BINARY=<path to claude> node scripts/vnext-provider-smoke.ts claude
```

The `*_SMOKE_BINARY` overrides default to `codex` / `claude` on `PATH`.

## Writing tests

- Unit: `*.test.ts` anywhere outside `e2e/`, `e2e-real/`.
- E2E: `e2e/`. Fixture CLIs: [test-fixtures/README.md](../test-fixtures/README.md).
- Real-provider: `e2e-real/` using `e2e-real/harness/`; gate with `describe.skipIf(process.env.RUN_REAL_PROVIDERS !== '1')`.
