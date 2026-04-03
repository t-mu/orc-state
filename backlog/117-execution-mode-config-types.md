---
ref: general/117-execution-mode-config-types
feature: general
priority: normal
status: todo
---

# Task 117 — Add Execution Mode Config Types and Loader

Independent.

## Scope

**In scope:**
- New `ExecutionMode` type and validation in `lib/providers.ts`
- Extend `MasterConfig` and `WorkerPoolConfig` with `execution_mode` field
- Extend `RawConfigFile` and `parseRawConfigFile()` for top-level `default_execution_mode`
- Loader logic in `loadMasterConfig()` and `loadWorkerPoolConfig()`
- Environment variable overrides
- Unit tests for all new loading/validation paths
- Update example `orchestrator.config.json`

**Out of scope:**
- Adapter flag changes (`adapters/pty.ts`)
- Coordinator or worker runtime changes
- Master session spawn changes (`cli/start-session.ts`)
- Doctor/preflight checks
- Documentation updates

---

## Context

### Current state

`lib/providers.ts` defines `MasterConfig` (provider, model) and `WorkerPoolConfig` (max_workers, provider, model, provider_models). Neither has an execution mode concept. Permission/sandbox flags are hardcoded per provider in `adapters/pty.ts` and `cli/start-session.ts`. There is no user-facing way to choose between full-access and sandboxed operation.

### Desired state

Both `MasterConfig` and `WorkerPoolConfig` include an `execution_mode` field with type `'full-access' | 'sandbox'`. The field loads through the standard 4-tier priority chain (env var > per-role config > top-level default > hardcoded default). Default is `'full-access'` for full backward compatibility. Invalid values are rejected with a clear error.

### Start here

- `lib/providers.ts` — config types, defaults, loaders, and `parseRawConfigFile()`
- `lib/providers.test.ts` — existing test patterns for config loading

**Affected files:**
- `lib/providers.ts` — types, defaults, loaders, parser
- `lib/providers.test.ts` — new tests
- `orchestrator.config.json` — add example `execution_mode` fields

---

## Goals

1. Must add `ExecutionMode = 'full-access' | 'sandbox'` type with `EXECUTION_MODES` const array and `isSupportedExecutionMode()` guard function.
2. Must add `execution_mode: ExecutionMode` to `MasterConfig` and `WorkerPoolConfig` interfaces.
3. Must add `default_execution_mode?: string` to `RawConfigFile` (follows `default_provider` naming convention).
4. Must extend `parseRawConfigFile()` to extract and validate `default_execution_mode`.
5. Must implement 4-tier loading priority in both `loadMasterConfig()` and `loadWorkerPoolConfig()`.
6. Must default to `'full-access'` when no execution mode is configured (backward compatible).
7. Must reject invalid execution mode values with a descriptive error/warning (follow existing pattern for invalid provider values).

---

## Implementation

### Step 1 — Add ExecutionMode type and guard

**File:** `lib/providers.ts`

Add near the existing `PROVIDERS` array and `isSupportedProvider()`:

```ts
export type ExecutionMode = 'full-access' | 'sandbox';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['full-access', 'sandbox'] as const;

export function isSupportedExecutionMode(value: string): value is ExecutionMode {
  return EXECUTION_MODES.includes(value as ExecutionMode);
}
```

### Step 2 — Extend config interfaces

**File:** `lib/providers.ts`

Add `execution_mode: ExecutionMode` to `MasterConfig` and `WorkerPoolConfig`.

Update `DEFAULT_MASTER_CONFIG` and `DEFAULT_WORKER_POOL_CONFIG` to include `execution_mode: 'full-access'`.

### Step 3 — Extend RawConfigFile and parser

**File:** `lib/providers.ts`

Add `default_execution_mode?: string` to the `RawConfigFile` interface (alongside existing `default_provider`).

In `parseRawConfigFile()`, extract `default_execution_mode` from the raw config object. If present and invalid, warn and ignore (follow existing pattern for `default_provider`).

### Step 4 — Update loadMasterConfig

**File:** `lib/providers.ts`

Loading priority:
1. `env.ORC_MASTER_EXECUTION_MODE`
2. `config.master?.execution_mode` (from raw config)
3. `config.default_execution_mode` (top-level fallback)
4. `'full-access'` (hardcoded default)

Validate the resolved value with `isSupportedExecutionMode()`. Warn and fall back to default if invalid.

### Step 5 — Update loadWorkerPoolConfig

**File:** `lib/providers.ts`

Same pattern as Step 4 but using `env.ORC_WORKER_EXECUTION_MODE` and `config.worker_pool?.execution_mode`.

### Step 6 — Update example config

**File:** `orchestrator.config.json`

Add `default_execution_mode` and per-role `execution_mode` fields with comments.

---

## Acceptance criteria

- [ ] `ExecutionMode` type exported from `lib/providers.ts`.
- [ ] `isSupportedExecutionMode()` correctly validates `'full-access'` and `'sandbox'` and rejects others.
- [ ] `loadMasterConfig()` returns `execution_mode: 'full-access'` when no config is set.
- [ ] `loadMasterConfig()` reads from env var `ORC_MASTER_EXECUTION_MODE` with highest priority.
- [ ] `loadMasterConfig()` reads from per-role config, then `default_execution_mode`, then hardcoded default.
- [ ] `loadWorkerPoolConfig()` follows the same 4-tier priority with `ORC_WORKER_EXECUTION_MODE`.
- [ ] Invalid `execution_mode` values are warned and fall back to default.
- [ ] Existing tests pass without modification (backward compatible).
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/providers.test.ts`:

```ts
describe('execution mode', () => {
  it('isSupportedExecutionMode accepts valid modes', () => { ... });
  it('isSupportedExecutionMode rejects invalid modes', () => { ... });
});

describe('loadMasterConfig execution_mode', () => {
  it('defaults to full-access when absent', () => { ... });
  it('reads from master.execution_mode in config', () => { ... });
  it('falls back to default_execution_mode', () => { ... });
  it('env var ORC_MASTER_EXECUTION_MODE overrides config', () => { ... });
  it('warns and defaults on invalid execution_mode', () => { ... });
});

describe('loadWorkerPoolConfig execution_mode', () => {
  it('defaults to full-access when absent', () => { ... });
  it('reads from worker_pool.execution_mode in config', () => { ... });
  it('falls back to default_execution_mode', () => { ... });
  it('env var ORC_WORKER_EXECUTION_MODE overrides config', () => { ... });
  it('warns and defaults on invalid execution_mode', () => { ... });
});
```

---

## Verification

```bash
npx vitest run lib/providers.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Minimal — additive type and config changes only. Default `'full-access'` preserves existing behavior.
**Rollback:** Revert the commit. No state file changes.
