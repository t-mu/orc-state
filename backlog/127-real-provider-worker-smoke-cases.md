---
ref: general/127-real-provider-worker-smoke-cases
feature: general
priority: high
status: done
depends_on:
  - general/126-real-provider-coordinator-worker-harness
---

# Task 127 — Add Real Claude and Codex Worker Smoke Cases

Depends on Task 126.

## Scope

**In scope:**
- Add one real-provider smoke test for `coordinator + Claude worker`
- Add one real-provider smoke test for `coordinator + Codex worker`
- Reuse the shared real-provider harness and blessed-path task fixtures
- Document how to run the suite, its env gating, and its limitations
- Verify the suite skips cleanly when providers are unavailable

**Out of scope:**
- Real master startup or `orc start-session` coverage
- Cross-provider master/worker combinations
- `input_request` flows
- Sandbox-mode matrix coverage
- Multiple concurrent workers

---

## Context

With the suite boundary and shared coordinator/worker harness in place, the final step is to add the two actual smoke cases the accepted plan calls for: one using a real Claude worker and one using a real Codex worker. These tests should prove the blessed path works with real provider PTY sessions while staying honest about limitations: they are functional smoke tests for coordinator + worker, not full-system startup tests and not hard host-level containment tests.

### Current state

The repo has no real-provider blessed-path smoke cases. Existing PTY/integration coverage uses fixture CLIs or mocked dispatch behavior. There is also no user-facing documentation for running opt-in real-provider coverage or for understanding what those tests do and do not guarantee.

### Desired state

Running `npm run test:real-providers` with the appropriate env flags should execute exactly two serial smoke cases:
- coordinator + real Claude worker
- coordinator + real Codex worker

Each case should prove that the coordinator dispatches the worker, the worker completes two sequential blessed-path tasks, lifecycle events occur in order, the worker is reused across tasks, and all orchestrator-managed paths remain inside the temp repo. The docs should explain the gating, requirements, and limitations clearly.

### Start here

- `e2e-real/harness/` — shared runtime repo, env, coordinator, and assertion helpers from Tasks 125-126
- `docs/getting-started.md` or a dedicated testing doc — place to document opt-in suite usage
- `package.json` — reference for the real-provider test script added in Task 125

**Affected files:**
- `e2e-real/worker-coordinator-claude.test.ts` — real Claude worker blessed-path smoke case
- `e2e-real/worker-coordinator-codex.test.ts` — real Codex worker blessed-path smoke case
- `docs/testing.md` or `docs/troubleshooting.md` — real-provider suite usage and limitations

---

## Goals

1. Must add a real-provider blessed-path smoke case for a Claude worker.
2. Must add a real-provider blessed-path smoke case for a Codex worker.
3. Must verify two sequential tasks complete in each case, proving worker reuse.
4. Must assert lifecycle transitions, event sequencing, and path containment rather than provider-specific text output.
5. Must skip cleanly when the target provider is unavailable or the suite env flags are not enabled.
6. Must document exactly what the suite covers and what it does not cover.

---

## Implementation

### Step 1 — Add the Claude smoke case

**File:** `e2e-real/worker-coordinator-claude.test.ts`

Use the shared harness to:
- create a temp git-backed runtime repo
- seed the managed-worker baseline for `provider=claude`
- start the real coordinator
- wait for two sequential tasks to complete
- assert lifecycle transitions, event sequencing, worker reuse, and path containment

Do not assert byte-for-byte provider output. Use state/events and bounded waits only.

### Step 2 — Add the Codex smoke case

**File:** `e2e-real/worker-coordinator-codex.test.ts`

Mirror the Claude case, changing only the worker provider and any provider-specific readiness gating needed by the shared harness.

### Step 3 — Document suite usage and limitations

**File:** `docs/testing.md`

Document:
- `npm run test:real-providers`
- required env flags
- required local provider binaries / sign-in expectations
- serial execution expectation
- the fact that this covers `coordinator + worker` only
- the fact that this is temp-repo-isolated functional smoke coverage, not hard host-level containment

---

## Acceptance criteria

- [ ] A real-provider Claude worker smoke case exists and uses the shared harness.
- [ ] A real-provider Codex worker smoke case exists and uses the shared harness.
- [ ] Each case validates two sequential task completions, worker reuse, lifecycle events, and temp-repo path containment.
- [ ] The tests skip cleanly when provider gating conditions are not met.
- [ ] Documentation explains how to run the suite and its limitations.
- [ ] No assertions depend on byte-stable provider output or exact file contents.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add:

```ts
// e2e-real/worker-coordinator-claude.test.ts
it('dispatches and completes two sequential blessed-path tasks with a real Claude worker', async () => { ... });

// e2e-real/worker-coordinator-codex.test.ts
it('dispatches and completes two sequential blessed-path tasks with a real Codex worker', async () => { ... });
```

Also add/extend a documentation or harness-level test if needed to verify the suite skips cleanly when the provider gating env flags are absent.

---

## Verification

```bash
npx vitest run --config vitest.real-providers.config.mjs
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Real provider CLIs can hang on first-run banners, auth issues, or PTY edge cases; without disciplined staging and diagnostics, failures will look flaky and obscure the true failure mode.
**Rollback:** git restore e2e-real docs/testing.md && npm test
