---
ref: general/2-cross-provider-runtime
feature: general
priority: high
status: todo
---

# Task 2 — Wire required_provider on Tasks and Add default_provider Config

Independent.

## Scope

**In scope:**
- Add `required_provider` field to `types/backlog.ts` Task type
- Add `required_provider` to `schemas/backlog.schema.json`
- Add `--required-provider` flag to `cli/task-create.ts`
- Add `required_provider` parameter to `mcp/handlers.ts` `handleCreateTask` and the `create_task` tool definition in `mcp/tools-list.ts`
- Add top-level `default_provider` key to `orchestrator.config.json` support; use it as fallback when `worker_pool.provider` is not explicitly set
- Document the provider fallback chain in `AGENTS.md`

**Out of scope:**
- Changing `lib/taskRouting.ts` — routing already evaluates `required_provider` correctly
- Changing agent registration, schema, or capabilities — already implemented
- Per-slot provider assignment in the worker pool
- Changing the master provider selection flow in `cli/start-session.ts`

---

## Context

The routing engine in `lib/taskRouting.ts` already checks `task.required_provider` against `agent.provider` and returns `eligible: false` on mismatch. However, `required_provider` is only defined in a local `TaskLike` interface inside `taskRouting.ts` — it does not exist on the `Task` type, is not in the backlog schema, and cannot be set through `create_task` (MCP) or `orc task-create` (CLI). Setting it requires directly editing `backlog.json`, which then fails `orc doctor` because the schema has `additionalProperties: false`.

Separately, the only way to configure the worker provider today is via `ORC_WORKER_PROVIDER` env var or `worker_pool.provider` in `orchestrator.config.json`. A simpler top-level `default_provider` key would let users express "use Claude for everything" without knowing about `worker_pool`.

### Current state
- `lib/taskRouting.ts`: evaluates `required_provider` via local `TaskLike` — routing works but field is invisible to users
- `types/backlog.ts`: has `required_capabilities` but no `required_provider`
- `schemas/backlog.schema.json`: has `required_capabilities` but no `required_provider`; `additionalProperties: false` causes `orc doctor` to reject manually-added fields
- `cli/task-create.ts`: has `--required-capabilities` but no `--required-provider`
- `mcp/handlers.ts` `handleCreateTask`: accepts `required_capabilities` but not `required_provider`
- `orchestrator.config.json`: supports `worker_pool.{ provider, max_workers, model }` — no top-level `default_provider`

### Desired state
- `Task` type and backlog schema include `required_provider` as an optional field
- `orc task-create --required-provider=claude` and `create_task(required_provider: "claude")` work end-to-end
- `orc doctor` passes for tasks that have `required_provider` set
- `orchestrator.config.json` accepts a top-level `default_provider` that `worker_pool.provider` falls back to
- Provider fallback chain is documented

### Provider fallback chain
```
task.required_provider          — route this task to a specific provider
  worker pool (all workers):
    ORC_WORKER_PROVIDER env
    → worker_pool.provider in orchestrator.config.json
    → default_provider in orchestrator.config.json
    → hardcoded default ('codex')
```

### Start here
- `types/backlog.ts` — Task type, add `required_provider`
- `schemas/backlog.schema.json` — Task definition, add field
- `lib/providers.ts` — `parseConfigFile()`, `loadWorkerPoolConfig()`
- `mcp/handlers.ts` — `handleCreateTask`

**Affected files:**
- `types/backlog.ts`
- `schemas/backlog.schema.json`
- `cli/task-create.ts`
- `mcp/handlers.ts`
- `mcp/tools-list.ts`
- `lib/providers.ts`
- `AGENTS.md`

---

## Goals

1. Must: `orc task-create --epic=orch --title="X" --required-provider=claude` creates a task with `required_provider: "claude"` in `backlog.json`.
2. Must: `create_task(epic, title, required_provider: "claude")` MCP call stores the field.
3. Must: `orc doctor` exits 0 for a task that has `required_provider` set.
4. Must: `canAgentExecuteTask()` continues to return `false` for a provider mismatch (no regression — logic already works, just needs the field to reach it).
5. Must: `loadWorkerPoolConfig()` uses `default_provider` from config as fallback when `worker_pool.provider` is absent.
6. Must: `default_provider` accepts the same values as `worker_pool.provider` (`codex`, `claude`, `gemini`) and throws on invalid values.
7. Must: `orc doctor` exits 0 after config and schema changes.

---

## Implementation

### Step 1 — Add `required_provider` to Task type

**File:** `types/backlog.ts`

```ts
// Add alongside required_capabilities:
required_provider?: 'codex' | 'claude' | 'gemini' | undefined;
```

Use the `Provider` union rather than a loose `string` to keep it consistent with `types/agents.ts`.

### Step 2 — Add `required_provider` to backlog schema

**File:** `schemas/backlog.schema.json` — inside the `Task` definition's `properties`:

```json
"required_provider": {
  "$ref": "#/definitions/Provider",
  "description": "When set, only agents with a matching provider field are eligible for this task."
}
```

Add a `Provider` definition to the backlog schema (mirroring `agents.schema.json`):

```json
"Provider": {
  "type": "string",
  "enum": ["codex", "claude", "gemini"]
}
```

Note: `"human"` is intentionally excluded — human-operated slots should not be auto-dispatched to.

### Step 3 — Add `--required-provider` to `orc task-create`

**File:** `cli/task-create.ts`

```ts
const requiredProvider = flag('required-provider');
// validate if present:
const VALID_PROVIDERS = new Set(['codex', 'claude', 'gemini']);
if (requiredProvider && !VALID_PROVIDERS.has(requiredProvider)) {
  console.error(`Invalid required-provider: ${requiredProvider}. Must be codex, claude, or gemini.`);
  process.exit(1);
}
```

Add to `newTask` construction (alongside `required_capabilities`):
```ts
if (requiredProvider) newTask.required_provider = requiredProvider as Task['required_provider'];
```

Update the usage comment at the top of the file.

### Step 4 — Add `required_provider` to `handleCreateTask` and tool definition

**File:** `mcp/handlers.ts` — `handleCreateTask`:

Destructure `required_provider` from args alongside `required_capabilities`. Validate it is one of the supported provider strings if present. Store on the task object (omit if null/undefined, same pattern as `required_capabilities`).

**File:** `mcp/tools-list.ts` — `create_task` tool:

Add to the input schema:
```json
"required_provider": {
  "type": "string",
  "enum": ["codex", "claude", "gemini"],
  "description": "Restrict dispatch to agents of this provider. Omit for any provider."
}
```

### Step 5 — Add `default_provider` to orchestrator config

**File:** `lib/providers.ts`

Extend `ConfigFileResult`:
```ts
interface ConfigFileResult {
  max_workers?: number | null;
  provider?: string | null;
  model?: string | null;
  default_provider?: string | null;  // new
}
```

In `parseConfigFile()`, read `default_provider` from the top level of the parsed config (not under `worker_pool`):
```ts
const topLevel = parsed as Record<string, unknown>;
const defaultProvider = typeof topLevel.default_provider === 'string'
  ? topLevel.default_provider : null;
```

In `loadWorkerPoolConfig()`, update the provider resolution:
```ts
const provider = env.ORC_WORKER_PROVIDER
  ?? fileConfig.provider
  ?? fileConfig.default_provider   // new fallback
  ?? DEFAULT_WORKER_POOL_CONFIG.provider;
```

Validate `default_provider` with `isSupportedProvider()` and throw if present but invalid.

### Step 6 — Document in AGENTS.md

Add a short section under "Orchestrator Conventions" documenting the provider fallback chain (the chain from the Desired state section above) and note that `required_provider` on a task overrides pool defaults for routing purposes.

---

## Acceptance criteria

- [ ] `orc task-create --epic=orch --title="Test" --required-provider=claude` creates task with `required_provider: "claude"` in `backlog.json`.
- [ ] `orc task-create --required-provider=invalid` exits non-zero with an error message.
- [ ] `create_task` MCP call with `required_provider: "codex"` stores the field on the task.
- [ ] `orc doctor` exits 0 for a backlog with a task that has `required_provider` set.
- [ ] A task with `required_provider: "claude"` is not dispatched to a `codex` agent (routing regression test).
- [ ] A task with `required_provider: "claude"` is dispatched to a `claude` agent when one is available.
- [ ] A task with no `required_provider` is dispatched to any eligible agent (no regression).
- [ ] `loadWorkerPoolConfig()` uses `default_provider` from config when `worker_pool.provider` is absent.
- [ ] `loadWorkerPoolConfig()` throws on an invalid `default_provider` value.
- [ ] `orc doctor` exits 0 after all changes.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `lib/taskRouting.test.ts` — already covers `required_provider` routing; add import of `Provider` type if needed, no logic changes.

**File:** `lib/providers.test.ts`

```ts
it('loadWorkerPoolConfig falls back to default_provider when worker_pool.provider is absent', () => { ... });
it('loadWorkerPoolConfig throws on invalid default_provider', () => { ... });
it('loadWorkerPoolConfig prefers worker_pool.provider over default_provider', () => { ... });
```

**File:** `cli/task-create.test.ts` or `mcp/handlers.test.ts`

```ts
it('create_task stores required_provider when provided', () => { ... });
it('create_task omits required_provider when not provided', () => { ... });
```

---

## Verification

```bash
# Targeted
npx vitest run lib/providers
npx vitest run lib/taskRouting
npx vitest run mcp/handlers

# Schema + state validation
node --experimental-strip-types cli/doctor.ts

# Smoke: create a task with required_provider and verify it persists
node --experimental-strip-types cli/task-create.ts \
  --epic=orch --title="Provider test" --required-provider=claude
node --experimental-strip-types cli/doctor.ts

# Full suite
nvm use 24 && npm test
```

## Risk / Rollback

**Risk:** `schemas/backlog.schema.json` uses `additionalProperties: false` on the Task definition. Adding `required_provider` without updating both the schema and the `Provider` definition will cause `orc doctor` to reject existing backlogs mid-task. Add both atomically in one write.

**Risk:** `default_provider` sits at the top level of `orchestrator.config.json`, not inside `worker_pool`. Verify `parseConfigFile()` reads both levels without collision.

**Rollback:** `git restore types/backlog.ts schemas/backlog.schema.json cli/task-create.ts mcp/handlers.ts mcp/tools-list.ts lib/providers.ts AGENTS.md && npm test`
