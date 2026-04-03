---
ref: publish/115-per-task-model-override
feature: publish
priority: normal
status: done
---

# Task 115 — Per-Task Model Override

Independent.

## Scope

**In scope:**
- Add `model` as a runtime-mutable field on tasks (`types/backlog.ts`)
- Accept `model` in `create_task` and `update_task` MCP tools
- Coordinator reads `task.model` when spawning workers, overriding pool defaults
- Add model assessment guidance to master bootstrap
- Update backlog schema validation
- Add tests

**Out of scope:**
- Automatic model routing rules (policy-based selection)
- Changing the adapter interface (it already accepts `model` in config)
- Adding thinking/reasoning level configuration
- Modifying the worker bootstrap

---

## Context

Currently all workers use the same model configured in `worker_pool.model` or `worker_pool.provider_models[provider]`. Trivial tasks (config edits, doc updates) waste expensive model capacity, while complex tasks might benefit from a stronger model.

The master agent is best positioned to assess task complexity during planning. This task adds a per-task `model` field so the master can set an appropriate model at task creation time. The coordinator respects it when spawning the worker.

### Current state

- Tasks have no `model` field
- All workers use `worker_pool.model` or `worker_pool.provider_models[provider]`
- `adapter.start()` already accepts `model` in its config object — no adapter changes needed
- `update_task` accepts `priority` and `required_provider` as runtime-mutable fields

### Desired state

- Tasks have an optional `model` field, settable via `create_task` and `update_task`
- Coordinator model resolution: `task.model` → `provider_models[provider]` → `worker_pool.model` → provider default
- Master bootstrap includes guidance on assessing complexity and setting model tier

### Start here

- `types/backlog.ts` — task type definition
- `mcp/tools-list.ts` — tool schemas for create_task and update_task
- `coordinator.ts` — where worker sessions are spawned with model config
- `lib/statusView.ts` — check if model needs to appear in status output

**Affected files:**
- `types/backlog.ts` — add `model` field
- `mcp/tools-list.ts` — add `model` to `create_task` and `update_task` schemas
- `mcp/handlers.ts` — handle `model` in create and update handlers
- `coordinator.ts` — read `task.model` when building worker session config
- `schemas/backlog.schema.json` — add `model` to task schema
- `templates/master-bootstrap-v1.txt` — add model assessment guidance
- `mcp/handlers.test.ts` — tests for model field in create/update

---

## Goals

1. Must add `model?: string | null` to the task type in `types/backlog.ts`.
2. Must accept `model` in both `create_task` and `update_task` MCP tools.
3. Must allow clearing the model override by passing `null` via `update_task`.
4. Must have the coordinator resolve model as: `task.model` → `provider_models[provider]` → `worker_pool.model` → provider default.
5. Must add model assessment guidance to the master bootstrap.
6. Must update `schemas/backlog.schema.json` to accept the `model` field.
7. Must pass `npm test`.

---

## Implementation

### Step 1 — Add model field to task type

**File:** `types/backlog.ts`

Add to the task interface:
```ts
model?: string | null;
```

### Step 2 — Update backlog schema

**File:** `schemas/backlog.schema.json`

Add `model` as an optional string-or-null field in the task properties.

### Step 3 — Accept model in create_task

**Files:** `mcp/tools-list.ts`, `mcp/handlers.ts`

Add to `create_task` input schema:
```ts
model: {
  type: ['string', 'null'],
  description: 'Model override for the worker session. Omit to use pool default.',
}
```

Handler: store `model` on the task record when provided.

### Step 4 — Accept model in update_task

**Files:** `mcp/tools-list.ts`, `mcp/handlers.ts`

Add to `update_task` input schema (same as create_task). Handler: allow setting and clearing (null removes the override).

### Step 5 — Coordinator reads task model

**File:** `coordinator.ts`

Find where the worker session config is built (where `model` is set from `worker_pool` config). Add task-level override:

```ts
const model = task.model ?? providerModels[provider] ?? workerPoolModel ?? null;
```

Pass this to `adapter.start()` in the config object.

### Step 6 — Add master bootstrap guidance

**File:** `templates/master-bootstrap-v1.txt`

Add near the "Planning new work" section:

```
When creating tasks, assess complexity and set an appropriate model:
- Trivial tasks (config edits, dependency bumps, doc updates): use a fast/cheap
  model via update_task(task_ref, model="claude-haiku-4-5")
- Standard tasks (feature implementation, bug fixes): use the pool default (omit model)
- Complex tasks (architectural changes, multi-system rewrites): consider a stronger
  model via update_task(task_ref, model="claude-sonnet-4-6")
If unsure, omit the model field and let the pool default apply.
```

### Step 7 — Tests

**File:** `mcp/handlers.test.ts`

```ts
it('create_task stores model field when provided');
it('update_task sets model field');
it('update_task clears model field when null is passed');
```

Coordinator test (if a test file exists for dispatch logic):
```ts
it('uses task.model over pool default when spawning worker');
```

---

## Acceptance criteria

- [ ] `create_task(title, model="claude-haiku-4-5")` stores model on the task.
- [ ] `update_task(task_ref, model="claude-haiku-4-5")` sets model.
- [ ] `update_task(task_ref, model=null)` clears model.
- [ ] `get_task(ref)` returns the model field.
- [ ] Coordinator spawns worker with task-level model when set.
- [ ] Coordinator falls back to pool default when task model is null/unset.
- [ ] `schemas/backlog.schema.json` validates the model field.
- [ ] Master bootstrap includes model assessment guidance.
- [ ] `orc doctor` exits 0 after the schema change.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `mcp/handlers.test.ts`:

```ts
it('create_task stores model field when provided');
it('update_task sets model field');
it('update_task clears model field when null is passed');
```

---

## Verification

```bash
# Verify schema accepts model
node -e "
import { readFileSync } from 'fs';
const schema = JSON.parse(readFileSync('schemas/backlog.schema.json', 'utf8'));
console.log('model in schema:', 'model' in (schema.properties?.tasks?.items?.properties ?? {}));
"

# Verify MCP tools accept model
grep 'model' mcp/tools-list.ts

# Full suite
nvm use 24 && npm test

# Schema validation
orc doctor
```

---

## Risk / Rollback

**Risk:** Adding a field to `backlog.schema.json` may cause `orc doctor` to reject existing backlog files that lack the field. The field must be optional with no default to avoid this.
**Rollback:** `git restore types/backlog.ts schemas/backlog.schema.json mcp/tools-list.ts mcp/handlers.ts coordinator.ts templates/master-bootstrap-v1.txt && npm test`
