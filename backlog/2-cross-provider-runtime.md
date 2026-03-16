---
ref: general/2-cross-provider-runtime
feature: general
priority: high
status: todo
---

# Task 2 — Implement Cross-Provider / Multi-Provider Runtime

Independent.

## Scope

**In scope:**
- Extend worker registration to support per-worker `provider` field independent of the pool-level default
- Wire `required_capabilities` from task spec into `canAgentExecuteTask()` and the coordinator's worker selection logic
- Allow `orc register-worker` and coordinator-managed slots to specify a provider per slot
- Add a `capabilities` field to agent registration so workers can advertise what they support

**Out of scope:**
- Changing the adapter interface (`adapters/interface.ts`)
- Supporting more than one simultaneous master agent
- Implementing a capability marketplace or dynamic capability discovery
- Changing task schema (capabilities field already exists in `types/backlog.ts`)

---

## Context

The adapter layer is fully provider-agnostic, but the runtime enforces a single provider for all workers via `ORC_WORKER_PROVIDER` in `lib/providers.ts`. The `required_capabilities` field in task specs is parsed and stored but never evaluated during dispatch. This means a task requiring a Claude-specific skill will be dispatched to any available worker regardless of provider.

### Current state
- `lib/providers.ts`: `WorkerPoolConfig.provider` is a single string applied to all managed slots
- `lib/taskRouting.ts` `canAgentExecuteTask()`: reads `required_capabilities` from task but returns `true` without checking them
- `types/agents.ts`: Agent type has no `capabilities` field
- `cli/register-worker.ts`: registers agent with role only, no provider or capabilities

### Desired state
- Each worker slot has an explicit `provider` field in `agents.json`
- `canAgentExecuteTask()` checks `task.required_capabilities` against `agent.capabilities`
- Coordinator-managed slots can mix providers (e.g., `orc-1=claude`, `orc-2=codex`)
- `orc register-worker` accepts `--capabilities=<cap1,cap2>` flag

### Start here
- `lib/taskRouting.ts` — `canAgentExecuteTask()` function
- `lib/providers.ts` — `WorkerPoolConfig` type and `reconcileManagedWorkerSlots()`
- `types/agents.ts` — `Agent` type definition

**Affected files:**
- `lib/taskRouting.ts` — capability matching logic
- `lib/providers.ts` — per-slot provider assignment
- `types/agents.ts` — add `capabilities` and `provider` fields to Agent type
- `cli/register-worker.ts` — add `--capabilities` and `--provider` flags
- `schemas/agents.schema.json` — add `capabilities` array and `provider` field

---

## Goals

1. Must: `canAgentExecuteTask()` returns `false` when a task's `required_capabilities` contains a value not present in the agent's `capabilities` array.
2. Must: Agent registration stores a `provider` field (defaults to pool provider if omitted).
3. Must: Agent registration stores a `capabilities` string array (defaults to `[]`).
4. Must: `orc register-worker --provider=codex --capabilities=code-review` works without error.
5. Must: Coordinator-managed slot creation passes `provider` per-slot when pool config supports mixed providers.
6. Must: `orc doctor` exits 0 after schema changes.

---

## Implementation

### Step 1 — Add `capabilities` and `provider` to Agent type

**File:** `types/agents.ts`

```ts
// Add to Agent interface:
provider?: string;          // e.g. 'claude' | 'codex' | 'gemini'
capabilities?: string[];    // e.g. ['code-review', 'implementation']
```

### Step 2 — Update agents schema

**File:** `schemas/agents.schema.json`

Add to agent object definition:
```json
"provider": { "type": "string" },
"capabilities": { "type": "array", "items": { "type": "string" }, "default": [] }
```

### Step 3 — Wire capability check in `canAgentExecuteTask()`

**File:** `lib/taskRouting.ts`

```ts
export function canAgentExecuteTask(task: TaskLike, agent: AgentLike): boolean {
  if (agent.role === 'master') return false;
  const required = task.required_capabilities ?? [];
  const agentCaps = agent.capabilities ?? [];
  if (required.length > 0 && !required.every((c) => agentCaps.includes(c))) return false;
  // existing task_type check ...
}
```

### Step 4 — Add `--capabilities` and `--provider` to `orc register-worker`

**File:** `cli/register-worker.ts`

```ts
const capabilities = (flag('capabilities') ?? '').split(',').filter(Boolean);
const provider = flag('provider') ?? workerPoolConfig.provider;
// pass to registerAgent(...)
```

### Step 5 — Store `provider` and `capabilities` in `registerAgent()`

**File:** `lib/agentRegistry.ts`

Add `provider` and `capabilities` parameters to `registerAgent()`, persist to `agents.json`.

### Step 6 — Pass per-slot provider in `reconcileManagedWorkerSlots()`

**File:** `lib/providers.ts`

If `WorkerPoolConfig` gains a `slotProviders?: Record<string, string>` map, use it to override the default provider per slot ID.

---

## Acceptance criteria

- [ ] `canAgentExecuteTask()` returns `false` for a task with `required_capabilities: ['code-review']` when agent has `capabilities: []`.
- [ ] `canAgentExecuteTask()` returns `true` for the same task when agent has `capabilities: ['code-review']`.
- [ ] `orc register-worker orc-2 --provider=codex --capabilities=code-review` registers agent with those fields in `agents.json`.
- [ ] `orc doctor` exits 0 after schema update.
- [ ] Tasks with no `required_capabilities` are dispatched to any available worker (no regression).
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/taskRouting.test.ts` (create if absent):

```ts
it('canAgentExecuteTask returns false when agent lacks required capability', () => { ... });
it('canAgentExecuteTask returns true when agent has all required capabilities', () => { ... });
it('canAgentExecuteTask returns true when task has no required_capabilities', () => { ... });
```

---

## Verification

```bash
# Targeted
npx vitest run lib/taskRouting

# Schema + state validation
node --experimental-strip-types cli/doctor.ts

# Full suite
nvm use 24 && npm test
```

```bash
# Smoke
node --experimental-strip-types cli/doctor.ts
# Expected: exits 0, no validation errors
```

## Risk / Rollback

**Risk:** Adding `provider` and `capabilities` to the agents schema with `additionalProperties: false` will reject existing agent records that lack these fields if they are marked required. Use `default: []` and make both optional.
**Rollback:** `git restore types/agents.ts lib/taskRouting.ts lib/agentRegistry.ts cli/register-worker.ts schemas/agents.schema.json lib/providers.ts && npm test`
