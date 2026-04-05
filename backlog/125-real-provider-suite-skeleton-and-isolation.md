---
ref: general/125-real-provider-suite-skeleton-and-isolation
feature: general
priority: high
status: done
---

# Task 125 — Build Real-Provider Suite Skeleton and Isolation Boundary

Independent.

## Scope

**In scope:**
- Add a separate opt-in Vitest project and npm script for real-provider smoke tests
- Create the initial `e2e-real/` suite layout and shared harness directory structure
- Build mandatory temp-repo creation with a real git repo, initial commit, and explicit `main` branch
- Pin orchestrator runtime paths into the temp repo via a single env/config boundary helper
- Provide a worker-visible `orc` wrapper that runs the source CLI entrypoint without depending on a prebuilt package artifact
- Clamp real-provider suite execution to serial mode and single-worker capacity

**Out of scope:**
- Starting the real coordinator or dispatching tasks
- Seeding managed worker/coordinator runtime state
- Adding the actual Claude/Codex smoke tests
- Adding cross-provider or real-master-session coverage
- Claiming hard host-level containment beyond orchestrator-managed paths

---

## Context

The accepted plan for real-provider coverage is intentionally narrow: coordinator + real worker provider only, with a strict temp-repo boundary so test workers cannot see the real backlog or `.orc-state`. The first step is not the tests themselves; it is building the suite boundary so later tasks can rely on an isolated repo, deterministic runtime env, serial execution, and a known-good `orc` command inside worker PTYs.

### Current state

The repo has `e2e/` and `*.integration.test.ts` coverage, but those tests run either against fixture CLIs or mocked adapter/coordinator boundaries. There is no dedicated real-provider Vitest project, no temp git-repo harness for orchestrator runs, and no isolated environment contract that pins backlog/state/worktrees/config into a disposable repo.

Worker sessions currently assume `orc` is runnable from their environment. A real-provider suite that points `ORC_REPO_ROOT` at a temp repo will fail immediately unless it also provides a worker-visible CLI entrypoint that does not depend on a prebuilt `dist/` artifact or on the temp repo itself containing the real source tree.

### Desired state

The repo should have a dedicated, opt-in real-provider test suite that always runs serially and always creates a disposable git-backed runtime repo with an explicit `main` branch. All orchestrator-managed runtime paths should be pinned into that temp root through one helper. Workers should receive an explicit `orc` wrapper that runs the source CLI from the real checkout while still keeping backlog/state/worktrees/artifacts inside the temp repo.

This task establishes the suite boundary only. Later tasks can then add coordinator bootstrapping, lifecycle assertions, and provider-specific smoke cases on top of a safe, reusable harness.

### Start here

- `vitest.e2e.config.mjs` — reference for creating a separate test project
- `package.json` — add the new real-provider test script
- `lib/orcBin.ts` — understand how the runtime currently resolves `orc`
- `lib/runWorktree.ts` — confirm git-backed worktree assumptions

**Affected files:**
- `vitest.real-providers.config.mjs` — new real-provider Vitest project
- `package.json` — add `test:real-providers` script
- `e2e-real/harness/runtimeRepo.ts` — create isolated temp git repos with explicit `main`
- `e2e-real/harness/runtimeEnv.ts` — pin runtime env and config paths into the temp repo
- `e2e-real/harness/orcWrapper.ts` — expose a worker-visible `orc` command backed by the source checkout

---

## Goals

1. Must add a dedicated opt-in real-provider Vitest project and npm script without changing normal `npm test`.
2. Must force the real-provider suite to run serially so provider PTYs and auth state are never exercised concurrently.
3. Must create a disposable git-backed runtime repo per test with an initial commit and an explicit `main` branch.
4. Must pin `ORCH_STATE_DIR`, `ORC_REPO_ROOT`, `ORC_WORKTREES_DIR`, `ORC_BACKLOG_DIR`, `ORC_CONFIG_FILE`, and `cwd` into the temp repo through one harness helper.
5. Must provide a worker-visible `orc` wrapper that does not depend on a prebuilt `dist/` artifact.
6. Must set single-worker capacity in the generated temp config to prevent coordinator fan-out.

---

## Implementation

### Step 1 — Add the real-provider Vitest project

**File:** `vitest.real-providers.config.mjs`

Create a dedicated config that includes only `e2e-real/**/*.test.ts`, uses the Node environment, and disables file-level concurrency so real provider runs never overlap.

The config should make the suite opt-in by file selection and by environment gating in the tests, not by altering the default test project.

### Step 2 — Add the suite entry script

**File:** `package.json`

Add a script like:

```json
"test:real-providers": "vitest run --config vitest.real-providers.config.mjs"
```

Do not change `test`, `test:e2e`, or the normal pretest flow.

### Step 3 — Create the temp git repo harness

**File:** `e2e-real/harness/runtimeRepo.ts`

Implement a helper that:
- creates a temp root outside the real checkout
- creates `backlog/`, `.orc-state/`, `artifacts/`, and a worktrees directory inside the temp root
- runs `git init`
- creates an initial commit
- explicitly creates/checks out `main`

Expected shape:

```ts
interface RuntimeRepo {
  repoRoot: string;
  stateDir: string;
  backlogDir: string;
  worktreesDir: string;
  artifactsDir: string;
  cleanup(): Promise<void>;
}
```

### Step 4 — Pin the runtime environment

**File:** `e2e-real/harness/runtimeEnv.ts`

Build a single helper that returns the exact env and cwd used for coordinator and worker launches. It must set:
- `ORCH_STATE_DIR`
- `ORC_REPO_ROOT`
- `ORC_WORKTREES_DIR`
- `ORC_BACKLOG_DIR`
- `ORC_CONFIG_FILE`
- `cwd`

It must also write a temp `orchestrator.config.json` with `worker_pool.max_workers = 1`.

### Step 5 — Provide a worker-visible `orc` wrapper

**File:** `e2e-real/harness/orcWrapper.ts`

Create a small wrapper script/command in the temp repo that invokes the source CLI entrypoint from the real checkout under Node 24. The harness must expose that wrapper through the runtime’s `orc` resolution path so worker PTYs can execute `run-start`, `run-heartbeat`, and related commands without depending on a built tarball or dist artifact.

Invariant: this wrapper may reuse the source checkout’s CLI code, but it must not redirect backlog/state/worktree paths back into the real checkout.

---

## Acceptance criteria

- [ ] `vitest.real-providers.config.mjs` exists and isolates `e2e-real/**/*.test.ts`.
- [ ] `npm run test:real-providers` exists and does not affect the default test suite.
- [ ] The real-provider suite is configured to run serially.
- [ ] The temp repo harness always initializes a real git repo with an explicit `main` branch.
- [ ] The runtime env helper pins all orchestrator-managed paths into the temp repo.
- [ ] The generated temp config sets `worker_pool.max_workers = 1`.
- [ ] The harness provides a runnable worker-visible `orc` command without depending on a prebuilt package artifact.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add targeted tests under `e2e-real/harness/` or an adjacent unit-style harness test file covering:

```ts
it('creates an isolated git repo on main', async () => { ... });
it('pins all runtime env paths into the temp repo', async () => { ... });
it('exposes a runnable orc wrapper for worker PTYs', async () => { ... });
it('configures the real-provider suite for serial execution', () => { ... });
```

---

## Verification

```bash
npx vitest run e2e-real/harness/*.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** A misconfigured wrapper or env helper can silently point worker commands back at the real checkout, defeating the isolation boundary before the real-provider tests even start.
**Rollback:** git restore vitest.real-providers.config.mjs package.json e2e-real/harness && npm test
