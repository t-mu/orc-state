# Testing

## Overview

The test suite has three tiers:

| Command | What it runs | When to use |
|---------|-------------|-------------|
| `npm test` | Unit + integration tests (no real providers) | Default — run on every change |
| `npm run test:e2e` | E2E tests with fixture CLIs | Before merging coordinator changes |
| `npm run test:real-providers` | Real-provider smoke tests (opt-in) | Before releases or after provider integration changes |

---

## Unit and integration tests

```bash
npm test
```

Runs all tests under `vitest.config.mjs`. Excludes `e2e/` and `e2e-real/`.
These tests use mocked adapters, fixture CLIs, or in-process state — no real
provider binary is required.

---

## E2E tests

```bash
npm run test:e2e
```

Runs tests under `e2e/`. Uses fixture CLI scripts that simulate provider
behavior at the PTY boundary without making real API calls.

---

## Real-provider smoke tests

```bash
RUN_REAL_PROVIDERS=1 npm run test:real-providers
```

Runs the opt-in real-provider suite under `e2e-real/`. This suite starts a
real coordinator process, dispatches tasks to real provider CLIs
(`claude`, `codex`), and validates the full coordinator + worker lifecycle.

### When to run

- Before cutting a release
- After changes to the coordinator dispatch or worker lifecycle code
- When debugging provider-specific PTY integration issues

### Required environment flags

| Variable | Required | Description |
|----------|----------|-------------|
| `RUN_REAL_PROVIDERS=1` | Yes | Opt-in gate. Without this, the smoke test suite skips all real-provider tests. |

### Required provider binaries

Each smoke test gates itself on the availability of the corresponding provider
binary. Tests skip automatically if the binary is not found, PTY support is
unavailable, or the binary does not spawn noninteractively.

| Provider | Binary | Install |
|----------|--------|---------|
| Claude | `claude` | `npm install -g @anthropic-ai/claude-code` |
| Codex | `codex` | `npm install -g @openai/codex` |

The suite does **not** verify auth (API key validity, active login session).
If a provider binary is installed but not authenticated, the coordinator
startup will fail with a runtime error — not a readiness failure. Set up auth
before running the suite:

- **Claude:** Run `claude` in a terminal and complete the login flow, or set `ANTHROPIC_API_KEY`.
- **Codex:** Run `codex` in a terminal and complete the login flow, or set `OPENAI_API_KEY`.

### Execution model

The suite runs **serially** (one file at a time, no concurrency). This is
enforced by `vitest.real-providers.config.mjs` (`fileParallelism: false`,
`singleFork: true`). Real provider sessions are expensive and must not overlap.

Each smoke test:
1. Creates an isolated temp git repo (outside the real checkout)
2. Seeds coordinator/worker runtime state (no real master session)
3. Starts a real coordinator process pointed at the temp repo
4. Dispatches two sequential tasks to a real provider worker
5. Polls for task completion and lifecycle events
6. Asserts path containment and cleans up

### Timeouts

Real provider sessions can take 3–5 minutes per task (the provider needs to
bootstrap, parse the TASK_START payload, and execute the spec). Each test
allows up to 3 minutes per task and 7 minutes overall.

If a test times out, check:
- Whether the provider binary hangs on an interactive prompt (first-run banners, auth flows)
- Whether the coordinator log shows a dispatch failure
- Whether the worker session started but stalled at a tool permission prompt

### What the suite covers

- `coordinator + real Claude worker`: blessed dispatch path with two sequential tasks
- `coordinator + real Codex worker`: blessed dispatch path with two sequential tasks

For each case, the test validates:
- Two sequential task completions (task 2 depends on task 1)
- Worker slot reuse across tasks (same agent ID handles both runs)
- Lifecycle event sequencing (`run_started` appears for each run)
- Path containment (all state, worktrees, and artifacts stay inside the temp repo)

### What the suite does NOT cover

- `orc start-session` or real master agent startup
- Cross-provider master/worker combinations
- `input_request` / `input_response` flows
- Sandbox-mode execution or host-level process containment
- Multiple concurrent workers
- Exact byte-stable provider output (no assertions on CLI text)

The real-provider suite is **functional smoke coverage**, not a security
boundary test. Path containment is verified at the filesystem level via
`run-worktrees.json` path checks, not hard OS-level sandboxing.

### Troubleshooting

**Test skips immediately without running:**
- Check that `RUN_REAL_PROVIDERS=1` is set in the environment.
- Check that the provider binary is installed and on `$PATH`.

**Coordinator startup timeout:**
- The coordinator must produce output within 15 seconds of starting.
- Check for startup errors: run `orc doctor` in the project root.

**Task completion timeout:**
- The worker session may be stalled at an interactive prompt.
- Run the provider CLI manually (`claude` or `codex`) and check for first-run auth flows.

**Path containment failure:**
- An orchestrator-managed path escaped the temp repo root.
- Check `run-worktrees.json` in the temp repo's `.orc-state/` directory.
- This is a coordinator bug — open an issue with the coordinator stdout from the test failure.

---

## Writing new tests

- Unit tests: add `*.test.ts` files anywhere except `e2e/` and `e2e-real/`.
- E2E tests: add files under `e2e/`.
- Real-provider smoke tests: add files under `e2e-real/` and use the shared
  harness in `e2e-real/harness/`. Gate new tests with `describe.skipIf(!ENABLED)`
  where `ENABLED = process.env.RUN_REAL_PROVIDERS === '1'`.
