---
ref: general/2-cross-provider-runtime
feature: general
priority: high
status: todo
---

# Task 2 — Enable Per-Slot Provider Assignment in Coordinator-Managed Worker Pool

Independent.

## Scope

**In scope:**
- Add `slot_providers?: Record<string, ProviderName>` to `WorkerPoolConfig` in `lib/providers.ts`
- Load `slot_providers` from `orchestrator.config.json` `worker_pool.slot_providers`
- Use per-slot provider when creating new managed slots in `createManagedSlotEntry()`
- Stop overwriting a managed slot's provider during reconciliation when it matches the slot's configured provider
- Add tests covering mixed-provider slot creation and reconciliation

**Out of scope:**
- Changing `types/agents.ts`, `schemas/agents.schema.json` — `provider` and `capabilities` fields already exist
- Changing `lib/taskRouting.ts` — capability and provider routing already fully implemented
- Changing `cli/register-worker.ts` — `--provider` and `--capabilities` flags already work
- Changing `lib/agentRegistry.ts` `registerAgent()` — already stores both fields
- Supporting dynamic capability discovery or a capability marketplace

---

## Context

The adapter layer and routing are already provider-agnostic: each `Agent` record carries its own `provider` field, `canAgentExecuteTask()` checks `required_capabilities` and `required_provider`, and `orc register-worker` already accepts `--provider` and `--capabilities`. The coordinator reads `agent.provider` when launching sessions (`getAdapter(agent.provider)`), so it will naturally use the right adapter per worker.

The only missing piece is the coordinator's managed slot lifecycle. `WorkerPoolConfig` has a single `provider: ProviderName` applied to all auto-managed slots. `reconcileManagedWorkerSlots()` not only creates new slots with this single provider but also actively resets an existing slot's `provider` back to the pool default on every reconcile tick — making it impossible for coordinator-managed slots (orc-1, orc-2, …) to hold different providers across ticks.

### Current state
- `WorkerPoolConfig` in `lib/providers.ts`: `{ max_workers, provider, model }` — single provider for all slots
- `createManagedSlotEntry()` in `lib/agentRegistry.ts`: always uses `workerPoolConfig.provider`
- `reconcileManagedWorkerSlots()` in `lib/agentRegistry.ts`: overwrites `existing.provider` to `workerPoolConfig.provider` when slot is idle
- `orchestrator.config.json` `worker_pool` supports `max_workers`, `provider`, `model` — no per-slot overrides
- A mixed pool (orc-1=claude, orc-2=codex) is impossible through the coordinator's auto-managed path

### Desired state
- `orchestrator.config.json` accepts `worker_pool.slot_providers: { "orc-1": "claude", "orc-2": "codex" }` to override provider per slot
- New managed slots are created with the slot-specific provider when one is configured
- Reconciliation does not overwrite a slot's provider when it matches its configured provider
- Pool-level `provider` remains the default for any slot not listed in `slot_providers`

### Start here
- `lib/providers.ts` — `WorkerPoolConfig`, `loadWorkerPoolConfig()`, `parseConfigFile()`
- `lib/agentRegistry.ts` — `createManagedSlotEntry()`, `reconcileManagedWorkerSlots()`

**Affected files:**
- `lib/providers.ts` — add `slot_providers` to `WorkerPoolConfig` and load it from config
- `lib/agentRegistry.ts` — thread `slot_providers` through slot creation and reconciliation
- `lib/providers.test.ts` — tests for `slot_providers` loading
- `lib/agentRegistry.test.ts` — tests for mixed-provider slot creation and reconciliation

---

## Goals

1. Must: `loadWorkerPoolConfig()` parses `worker_pool.slot_providers` from `orchestrator.config.json` and populates `WorkerPoolConfig.slot_providers`.
2. Must: A new managed slot for `orc-1` uses the provider from `slot_providers["orc-1"]` when present, falling back to `WorkerPoolConfig.provider`.
3. Must: `reconcileManagedWorkerSlots()` does not overwrite an existing idle slot's `provider` when it matches the slot's configured provider (whether from `slot_providers` or pool default).
4. Must: Pool-level `provider` default continues to apply for any slot not listed in `slot_providers`.
5. Must: `orc doctor` exits 0 after the changes (no schema changes required, but verify).
6. Must: All existing `lib/agentRegistry.test.ts` tests continue to pass.

---

## Implementation

### Step 1 — Add `slot_providers` to `WorkerPoolConfig`

**File:** `lib/providers.ts`

```ts
export interface WorkerPoolConfig {
  max_workers: number;
  provider: ProviderName;
  model: string | null;
  slot_providers: Record<string, ProviderName>;  // per-slot overrides; empty = use pool default
}

export const DEFAULT_WORKER_POOL_CONFIG: Readonly<WorkerPoolConfig> = Object.freeze({
  max_workers: 0,
  provider: 'codex' as ProviderName,
  model: null,
  slot_providers: {},
});
```

### Step 2 — Parse `slot_providers` from config file

**File:** `lib/providers.ts` — extend `ConfigFileResult` and `parseConfigFile()`

```ts
interface ConfigFileResult {
  max_workers?: number | null;
  provider?: string | null;
  model?: string | null;
  slot_providers?: Record<string, string> | null;
}
```

In `parseConfigFile()`, after reading `wp.model`:
```ts
const rawSlotProviders = wp.slot_providers;
let slot_providers: Record<string, string> | null = null;
if (rawSlotProviders != null) {
  if (typeof rawSlotProviders !== 'object' || Array.isArray(rawSlotProviders)) {
    throw new Error(`Invalid orchestrator config: worker_pool.slot_providers must be an object`);
  }
  for (const [slotId, p] of Object.entries(rawSlotProviders as Record<string, unknown>)) {
    if (!isSupportedProvider(p)) {
      throw new Error(`Invalid provider '${String(p)}' for slot '${slotId}' in worker_pool.slot_providers`);
    }
  }
  slot_providers = rawSlotProviders as Record<string, string>;
}
return { ..., slot_providers };
```

In `loadWorkerPoolConfig()`, add:
```ts
const slot_providers = fileConfig.slot_providers ?? {};
// validate each entry is a supported provider (already done in parseConfigFile)
return { ..., slot_providers };
```

### Step 3 — Thread `slot_providers` through slot creation

**File:** `lib/agentRegistry.ts` — update `createManagedSlotEntry()`

```ts
function createManagedSlotEntry(agentId: string, workerPoolConfig: WorkerPoolConfig): Agent {
  const provider = workerPoolConfig.slot_providers[agentId] ?? workerPoolConfig.provider;
  return {
    agent_id: agentId,
    provider,
    model: workerPoolConfig.model,
    // ... rest unchanged
  };
}
```

### Step 4 — Fix reconciliation to respect per-slot provider

**File:** `lib/agentRegistry.ts` — update `reconcileManagedWorkerSlots()`

The current reconcile code overwrites `existing.provider` whenever it differs from `workerPoolConfig.provider`. Replace with a check against the slot's configured provider:

```ts
const configuredProvider = workerPoolConfig.slot_providers[agentId] ?? workerPoolConfig.provider;
const configuredModel = workerPoolConfig.model;

if (canRefreshProviderBinding && (
  existing.provider !== configuredProvider
  || existing.model !== configuredModel
)) {
  existing.provider = configuredProvider;
  existing.model = configuredModel;
  modified = true;
}
```

---

## Acceptance criteria

- [ ] `loadWorkerPoolConfig()` returns `slot_providers: { "orc-1": "claude" }` when `orchestrator.config.json` has `worker_pool.slot_providers: { "orc-1": "claude" }`.
- [ ] `loadWorkerPoolConfig()` returns `slot_providers: {}` when `orchestrator.config.json` has no `slot_providers` key.
- [ ] `loadWorkerPoolConfig()` throws when `slot_providers` contains an unsupported provider value.
- [ ] A newly created managed slot for `orc-1` uses `claude` when `slot_providers["orc-1"] = "claude"`.
- [ ] A newly created managed slot for `orc-2` uses the pool default when `orc-2` is not in `slot_providers`.
- [ ] `reconcileManagedWorkerSlots()` does not modify an existing idle slot whose `provider` already matches its configured provider.
- [ ] `reconcileManagedWorkerSlots()` does update an existing idle slot whose `provider` differs from its configured provider.
- [ ] All existing `lib/agentRegistry.test.ts` tests pass unchanged.
- [ ] `orc doctor` exits 0.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `lib/providers.test.ts`

```ts
it('loadWorkerPoolConfig parses slot_providers from config file', () => { ... });
it('loadWorkerPoolConfig returns empty slot_providers when key is absent', () => { ... });
it('loadWorkerPoolConfig throws on unsupported provider in slot_providers', () => { ... });
```

**File:** `lib/agentRegistry.test.ts`

```ts
it('reconcileManagedWorkerSlots creates orc-1 with claude when slot_providers specifies claude', () => { ... });
it('reconcileManagedWorkerSlots creates orc-2 with pool default when not in slot_providers', () => { ... });
it('reconcileManagedWorkerSlots does not overwrite provider of idle slot matching configured provider', () => { ... });
it('reconcileManagedWorkerSlots resets provider of idle slot that drifted from configured provider', () => { ... });
```

---

## Verification

```bash
# Targeted
npx vitest run lib/providers
npx vitest run lib/agentRegistry

# Schema + state validation
node --experimental-strip-types cli/doctor.ts

# Full suite
nvm use 24 && npm test
```

## Risk / Rollback

**Risk:** `WorkerPoolConfig` is used in several call sites across `coordinator.ts` and `lib/agentRegistry.ts`. Adding `slot_providers` as a required field means all call sites that construct a `WorkerPoolConfig` directly (e.g. in tests) need to include it. Use `slot_providers: {}` as the default in `DEFAULT_WORKER_POOL_CONFIG` and make it a required field with an empty-object default to avoid silent omissions.

**Risk:** `reconcileManagedWorkerSlots()` change affects the live coordinator tick. If the logic is wrong, all managed slots could be pinned to the wrong provider on the next tick. Verify with `agentRegistry.test.ts` before merging.

**Rollback:** `git restore lib/providers.ts lib/agentRegistry.ts && npm test`
