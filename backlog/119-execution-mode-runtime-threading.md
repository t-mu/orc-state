---
ref: general/119-execution-mode-runtime-threading
feature: general
priority: normal
status: todo
depends_on:
  - general/118-execution-mode-adapter-flags
---

# Task 119 — Thread Execution Mode Through Worker Runtime and Coordinator

Depends on Task 118 (adapter flag mapping). Blocks Task 121 (docs).

## Scope

**In scope:**
- Add `executionMode` parameter to `launchWorkerSession()` in `lib/workerRuntime.ts`
- Enforce scout override: scouts always get `'sandbox'` regardless of config
- Thread execution mode from coordinator through `ensureSessionReady` to `launchWorkerSession` to `adapter.start()`
- Trace and update every handoff point in the call chain

**Out of scope:**
- Config types/loaders (`lib/providers.ts` — done in Task 117)
- Adapter flag logic (`adapters/pty.ts` — done in Task 118)
- Master session (`cli/start-session.ts` — Task 120)
- Doctor checks, documentation

---

## Context

### Current state

The call chain for worker launches is:
1. `coordinator.ts` → `ensureSessionReady()` constructs launch config and calls `launchWorkerSession()`
2. `lib/workerRuntime.ts` → `launchWorkerSession()` extracts named fields and calls `adapter.start()`
3. `adapters/pty.ts` → `start()` receives config bag and calls `buildStartArgs()`

`execution_mode` does not exist in any of these handoff points. The `WorkerPoolConfig` now has `execution_mode` (from Task 117) but it is not threaded through to the adapter.

For scouts, `read_only: agent.role === 'scout'` is set at line 155 of `workerRuntime.ts` but execution mode has no scout override.

### Desired state

`execution_mode` flows from `WorkerPoolConfig` through every handoff point to `adapter.start()`. Scouts are forced to `'sandbox'` regardless of the configured mode, enforced at the `launchWorkerSession` level (single enforcement point).

### Start here

- `lib/workerRuntime.ts` — `launchWorkerSession()` function, `Adapter` interface
- `coordinator.ts` — `ensureSessionReady()` and its call sites

**Affected files:**
- `lib/workerRuntime.ts` — `launchWorkerSession()` parameters, scout override logic
- `coordinator.ts` — `ensureSessionReady()` and call sites that construct launch config

---

## Goals

1. Must add `executionMode` as a named parameter to `launchWorkerSession()`.
2. Must enforce scout override: `execution_mode = 'sandbox'` when `agent.role === 'scout'`, regardless of the passed value.
3. Must pass `execution_mode` from `launchWorkerSession` to `adapter.start()` config.
4. Must thread `execution_mode` from `WorkerPoolConfig` through every coordinator call site that invokes `launchWorkerSession`.
5. Must default to `'full-access'` when `executionMode` is not provided (backward compatible for any direct callers).

---

## Implementation

### Step 1 — Add executionMode to launchWorkerSession

**File:** `lib/workerRuntime.ts`

Add `executionMode?: string` to the function parameters (or the options object if one exists).

Inside the function, compute the effective mode:
```ts
const effectiveMode = agent.role === 'scout' ? 'sandbox' : (executionMode ?? 'full-access');
```

Pass `execution_mode: effectiveMode` in the config object to `adapter.start()`.

### Step 2 — Thread through ensureSessionReady in coordinator

**File:** `coordinator.ts`

Find `ensureSessionReady` and its call sites. The coordinator already loads `WorkerPoolConfig` (via `loadWorkerPoolConfig()`). Thread `config.execution_mode` through:

1. From where `WorkerPoolConfig` is loaded
2. Into `ensureSessionReady`'s parameters or the launch config it constructs
3. Into the `launchWorkerSession()` call

### Step 3 — Verify all call sites

**File:** `coordinator.ts`

Grep for all invocations of `launchWorkerSession` and `ensureSessionReady`. Ensure every call site passes `executionMode`. There may be multiple paths (initial dispatch, retry, finalize rebase) — all must be updated.

---

## Acceptance criteria

- [ ] `launchWorkerSession()` accepts `executionMode` parameter.
- [ ] Scouts always receive `execution_mode: 'sandbox'` in adapter config, even if `'full-access'` is passed.
- [ ] Non-scout workers receive the configured `execution_mode` in adapter config.
- [ ] All coordinator call sites that invoke `launchWorkerSession` pass the execution mode.
- [ ] Missing `executionMode` parameter defaults to `'full-access'` behavior.
- [ ] All existing tests pass.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to or create tests for `lib/workerRuntime.ts`:

```ts
describe('launchWorkerSession execution mode', () => {
  it('passes execution_mode to adapter.start', () => { ... });
  it('scout override: always sandbox regardless of input', () => { ... });
  it('defaults to full-access when executionMode omitted', () => { ... });
  it('non-scout workers receive configured mode', () => { ... });
});
```

---

## Verification

```bash
npx vitest run lib/workerRuntime
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Low — threading a new parameter through existing call chain. No behavioral change for existing configs (default full-access).
**Rollback:** Revert the commit.
