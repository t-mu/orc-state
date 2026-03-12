# TypeScript Migration Plan

## Approach

- **No build step.** Node 24 supports `--experimental-strip-types` natively. `tsc` runs as type-check only (`noEmit: true`). Source files are `.ts`, published as-is. No `dist/` folder.
- **Strict mode from day one.** Start with `"strict": true` — easier to do upfront than retrofit later.
- **Types before code.** Generate/write all shared types first, then convert modules layer by layer (lib → cli → mcp → adapters → root). Each layer depends only on types from layers below.
- **Tests last, optionally.** Vitest handles `.ts` source without converting test files. Convert tests after everything else passes.

---

## Step 1 — Setup (1–2 hours)

### 1a. Install TypeScript and Node types

```bash
npm install --save-dev typescript @types/node
```

Pin exact versions in `package.json` per project convention.

### 1b. Create `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
```

- `noEmit: true` — type-check only, Node runs `.ts` directly
- `allowImportingTsExtensions` — allows `import './foo.ts'` in source
- `resolveJsonModule` — needed for importing schemas

### 1c. Update `package.json` scripts

```json
"typecheck": "tsc --noEmit",
"test": "vitest run",
"pretest": "tsc --noEmit"
```

Add `typecheck` to CI. `pretest` makes type errors block test runs.

### 1d. Update Node invocation in `bin`

In `cli/orc.mjs` (will become `cli/orc.ts`), the shebang becomes:

```
#!/usr/bin/env -S node --experimental-strip-types
```

### 1e. Rename strategy

Files move from `.mjs` → `.ts`. Internal imports change from `'./foo.mjs'` → `'./foo.ts'`. Do this per-step, not all at once. Keep unconverted files as `.mjs` during migration — TypeScript will resolve them.

---

## Step 2 — Generate Types from JSON Schemas (2–3 hours)

This is the highest-leverage step. All 5 schemas map directly to TypeScript interfaces. Do this before touching any source files.

### 2a. Install `json-schema-to-typescript` (dev-only, or run once)

```bash
npx json-schema-to-typescript schemas/backlog.schema.json -o types/backlog.ts
npx json-schema-to-typescript schemas/agents.schema.json -o types/agents.ts
npx json-schema-to-typescript schemas/claims.schema.json -o types/claims.ts
npx json-schema-to-typescript schemas/run-worktrees.schema.json -o types/run-worktrees.ts
npx json-schema-to-typescript schemas/snapshot.schema.json -o types/snapshot.ts
```

Review and clean up the generated output — rename types to match conventions, add missing union literals if the generator misses enums.

### 2b. Key types to verify come out correctly

**From `backlog.schema.json`:**
```typescript
export type TaskStatus = 'todo' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'released';
export type TaskType = 'implementation' | 'refactor';
export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type PlanningState = 'ready_for_dispatch' | 'archived';

export interface Task {
  ref: string;
  title: string;
  status: TaskStatus;
  task_type?: TaskType;
  priority?: Priority;
  planning_state?: PlanningState;
  depends_on?: string[];
  acceptance_criteria?: string[];
  required_capabilities?: string[];
  owner?: string;
  delegated_by?: string;
  attempt_count?: number;
  blocked_reason?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Feature {      // renamed from Epic per task 160
  ref: string;
  title: string;
  description?: string;
  tasks: Task[];
  created_at?: string;
}

export interface Backlog {
  version: '1';
  features: Feature[];
  next_task_seq?: number;
}
```

**From `agents.schema.json`:**
```typescript
export type AgentStatus = 'idle' | 'running' | 'offline' | 'dead';
export type AgentRole = 'worker' | 'reviewer' | 'master';
export type Provider = 'codex' | 'claude' | 'gemini' | 'human';
export type DispatchMode = 'autonomous' | 'supervised' | 'human-commanded' | null;

export interface Agent {
  agent_id: string;
  provider: Provider;
  model?: string | null;
  status: AgentStatus;
  role: AgentRole;
  dispatch_mode?: DispatchMode;
  capabilities?: string[];
  session_handle?: string | null;
  provider_ref?: Record<string, unknown> | null;
  registered_at: string;
  last_heartbeat_at?: string | null;
  last_status_change_at?: string | null;
}

export interface AgentsState {
  version: '1';
  agents: Agent[];
}
```

**From `claims.schema.json`:**
```typescript
export type ClaimState = 'claimed' | 'in_progress' | 'done' | 'failed';
export type FinalizationState =
  | 'awaiting_finalize'
  | 'finalize_rebase_requested'
  | 'finalize_rebase_in_progress'
  | 'ready_to_merge'
  | 'blocked_finalize'
  | null;

export interface Claim {
  run_id: string;
  task_ref: string;
  agent_id: string;
  state: ClaimState;
  claimed_at: string;
  lease_expires_at: string;
  last_heartbeat_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  failure_reason?: string;
  finalization_state?: FinalizationState;
  finalization_retry_count: number;
  finalization_blocked_reason?: string | null;
  input_state?: 'awaiting_input' | null;
  input_requested_at?: string | null;
}

export interface ClaimsState {
  version: '1';
  claims: Claim[];
}
```

### 2c. Create `types/index.ts` barrel

```typescript
export * from './backlog.ts';
export * from './agents.ts';
export * from './claims.ts';
export * from './run-worktrees.ts';
export * from './snapshot.ts';
export * from './events.ts';   // Step 3
```

---

## Step 3 — Event Discriminated Union (2–3 hours) ⚠️ Most important step

This is the most design-sensitive part. The event schema uses `additionalProperties: true` on payload — `json-schema-to-typescript` won't generate useful payload types. Must be hand-written.

### 3a. Shared base fields

```typescript
export type ActorType = 'agent' | 'coordinator' | 'human';
export type FailurePolicy = 'requeue' | 'block';

interface BaseEvent {
  seq: number;
  ts: string;
  actor_type: ActorType;
  actor_id: string;
}
```

### 3b. Task events (require `task_ref`)

```typescript
interface TaskAddedEvent extends BaseEvent {
  event: 'task_added';
  task_ref: string;
  payload: { title: string; task_type?: string; feature_ref?: string };
}
interface TaskUpdatedEvent extends BaseEvent {
  event: 'task_updated';
  task_ref: string;
  payload: { status: string; [key: string]: unknown };
}
interface TaskCancelledEvent extends BaseEvent {
  event: 'task_cancelled';
  task_ref: string;
  payload: Record<string, never>;
}
interface TaskReleasedEvent extends BaseEvent {
  event: 'task_released';
  task_ref: string;
  payload: Record<string, never>;
}
interface TaskDelegatedEvent extends BaseEvent {
  event: 'task_delegated';
  task_ref: string;
  payload: { agent_id: string; [key: string]: unknown };
}
```

### 3c. Run lifecycle events (require `run_id`, most also `task_ref`)

```typescript
interface ClaimCreatedEvent extends BaseEvent {
  event: 'claim_created';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { lease_expires_at: string };
}
interface ClaimRenewedEvent extends BaseEvent {
  event: 'claim_renewed';
  run_id: string;
  agent_id: string;
  payload: { lease_expires_at: string };
}
interface ClaimExpiredEvent extends BaseEvent {
  event: 'claim_expired';
  run_id: string;
  payload: { policy: FailurePolicy };
}
interface RunStartedEvent extends BaseEvent {
  event: 'run_started';
  run_id: string;
  agent_id: string;
  payload: Record<string, never>;
}
interface WorkCompleteEvent extends BaseEvent {
  event: 'work_complete';
  run_id: string;
  agent_id: string;
  payload: { status: 'work_complete'; retry_count?: number };
}
interface RunFinishedEvent extends BaseEvent {
  event: 'run_finished';
  run_id: string;
  agent_id: string;
  payload: Record<string, never>;
}
interface RunFailedEvent extends BaseEvent {
  event: 'run_failed';
  run_id: string;
  agent_id: string;
  payload: { policy: FailurePolicy; reason?: string };
}
interface InputRequestedEvent extends BaseEvent {
  event: 'input_requested';
  run_id: string;
  agent_id: string;
  payload: { question: string };
}
interface InputResponseEvent extends BaseEvent {
  event: 'input_response';
  run_id: string;
  agent_id: string;
  payload: { response: string };
}
// ... remaining run lifecycle events follow same pattern
```

### 3d. Agent events (require `agent_id`)

```typescript
interface AgentRegisteredEvent extends BaseEvent {
  event: 'agent_registered';
  agent_id: string;
  payload: { provider: string; role: string };
}
interface AgentMarkedDeadEvent extends BaseEvent {
  event: 'agent_marked_dead';
  agent_id: string;
  payload: { elapsed_ms: number };
}
interface SessionStartFailedEvent extends BaseEvent {
  event: 'session_start_failed';
  agent_id: string;
  payload: { reason: string };
}
// agent_online, agent_offline follow same pattern
```

### 3e. Coordinator + misc events

```typescript
interface CoordinatorStartedEvent extends BaseEvent {
  event: 'coordinator_started';
  payload: Record<string, never>;
}
interface HeartbeatEvent extends BaseEvent {
  event: 'heartbeat';
  run_id: string;
  agent_id: string;
  payload: Record<string, never>;
}
```

### 3f. Final union type

```typescript
export type OrcEvent =
  | TaskAddedEvent
  | TaskUpdatedEvent
  | TaskCancelledEvent
  | TaskReleasedEvent
  | TaskDelegatedEvent
  | ClaimCreatedEvent
  | ClaimRenewedEvent
  | ClaimExpiredEvent
  | RunStartedEvent
  | WorkCompleteEvent
  | RunFinishedEvent
  | RunFailedEvent
  | InputRequestedEvent
  | InputResponseEvent
  | AgentRegisteredEvent
  | AgentMarkedDeadEvent
  | SessionStartFailedEvent
  | CoordinatorStartedEvent
  | HeartbeatEvent
  | /* remaining ~12 events */;
```

### 3g. Type guard helpers

```typescript
export function isRunEvent(e: OrcEvent): e is Extract<OrcEvent, { run_id: string }> {
  return 'run_id' in e;
}
export function isTaskEvent(e: OrcEvent): e is Extract<OrcEvent, { task_ref: string }> {
  return 'task_ref' in e;
}
```

> **Note:** `validateEventObject()` in `eventValidation.ts` keeps its runtime validation — it guards the boundary where raw JSON enters the system. The discriminated union is for internal type safety after validation.

---

## Step 4 — Convert `lib/` (8–10 hours)

Convert in dependency order — lowest-level modules first.

### 4a. Zero-dependency utilities first

- `lib/args.mjs` → `lib/args.ts`
  - `flag(name: string, argv?: string[]): string | null`
  - `intFlag(name: string, defaultVal: number, argv?: string[]): number`
  - `flagAll(name: string, argv?: string[]): string[]`

- `lib/atomicWrite.mjs` → `lib/atomicWrite.ts`
  - `atomicWriteJson(filePath: string, data: unknown): void`

- `lib/lock.mjs` → `lib/lock.ts`
  - `withLock<T>(lockPath: string, fn: () => T): T`
  - `withLockAsync<T>(lockPath: string, fn: () => Promise<T>): Promise<T>`
  - `acquireLock(lockPath: string): void`
  - `releaseLock(lockPath: string): void`

### 4b. State readers

`lib/stateReader.mjs` → `lib/stateReader.ts` — add typed wrappers per state file:

```typescript
export function readBacklog(stateDir: string): Backlog
export function readAgents(stateDir: string): AgentsState
export function readClaims(stateDir: string): ClaimsState
export function readJson(stateDir: string, file: string): unknown  // keep for untyped reads
export function findTask(backlog: Backlog, taskRef: string): Task | null
export function getNextTaskSeq(backlog: Backlog): number
```

These typed wrappers eliminate `as Backlog` casts everywhere downstream.

### 4c. Validation modules

- `lib/eventValidation.mjs` → `lib/eventValidation.ts`
  - Input: `unknown` (raw parsed JSON from log file)
  - Output: `string[]` (validation errors)
  - After validation passes, callers can assert `event as OrcEvent`

- `lib/stateValidation.mjs` → `lib/stateValidation.ts`
  - `validateBacklog(data: unknown): string[]`
  - `validateAgents(data: unknown): string[]`
  - `validateClaims(data: unknown): string[]`

### 4d. Event log

`lib/eventLog.mjs` → `lib/eventLog.ts`

```typescript
export function appendSequencedEvent(
  stateDir: string,
  event: Omit<OrcEvent, 'seq'>,     // seq is auto-assigned
  opts?: { fsyncPolicy?: 'always' | 'never'; lockAlreadyHeld?: boolean }
): number

export function readEvents(logPath: string): OrcEvent[]
export function readEventsSince(logPath: string, afterSeq: number): OrcEvent[]
export function readRecentEvents(logPath: string, limit?: number): OrcEvent[]
```

`Omit<OrcEvent, 'seq'>` on the input is important — callers don't provide `seq`, the function allocates it.

### 4e. Remaining `lib/` modules

Batch convert the remaining ~28 lib modules. Expected pattern: add parameter types, add return types, remove casts. ~15–20 min per module.

Trickier modules to watch:
- `lib/statusView.mjs` (477 LOC) — iterates agents + claims + backlog; needs all three state types
- `lib/claimManager.mjs` (388 LOC) — heavy state mutation; needs `Claim`, `ClaimState`, `FinalizationState`
- `lib/reconcile.mjs` — snapshot rebuild; needs `Snapshot` type from schema
- `lib/taskRouting.mjs` — matching logic; needs `Task`, `Agent`, capability arrays

---

## Step 5 — Convert `cli/` (6–8 hours)

34 CLI command files. Mostly mechanical once `lib/` is typed.

Each file follows the same import pattern:

```typescript
import { flag, flagAll } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import type { Task, Backlog, TaskType } from '../types/index.ts';
```

Main work per file:
1. Add explicit types to constructed objects (`const newTask: Task = { ... }`)
2. Type the `withLock` callback
3. Type event objects as the correct `OrcEvent` member

Update shebang in `cli/orc.ts`:
```
#!/usr/bin/env -S node --experimental-strip-types
```

---

## Step 6 — Convert `mcp/` (2–3 hours)

`mcp/handlers.mjs` (743 LOC) is the largest single file. Key concerns:

- `LIST_TASK_FIELDS` → `Set<keyof Task>`
- `toTaskSummary()` → `(task: Task) => Partial<Task>`
- `TASK_STATUSES` → `Set<TaskStatus>` (enables proper narrowing)

`mcp/tools-list.mjs` and `mcp/server.mjs` are smaller — straightforward conversion.

---

## Step 7 — Convert `adapters/` and root (2–3 hours)

- `adapters/interface.mjs` → `adapters/interface.ts` — key candidate for a formal `interface AdapterContract`
- `adapters/pty.mjs` → `adapters/pty.ts` — `node-pty` ships its own types
- `adapters/index.mjs` → `adapters/index.ts`
- `index.mjs` → `index.ts` — update public API exports
- `coordinator.mjs` → `coordinator.ts`

Update `package.json` exports:

```json
"exports": {
  ".": "./index.ts",
  "./adapters": "./adapters/index.ts",
  "./coordinator": "./coordinator.ts",
  "./schemas/*": "./schemas/*.json"
}
```

---

## Step 8 — Convert test files (6–8 hours, deferrable)

Vitest resolves `.ts` imports automatically — test files can stay `.mjs` during migration and still test `.ts` source. Convert when convenient:

1. Rename `.test.mjs` → `.test.ts`
2. Update import extensions
3. Add types to fixture objects (typos in fixtures become compile errors)

---

## Step 9 — Verify and Harden (2–3 hours)

```bash
npm run typecheck   # tsc --noEmit across all .ts files
npm test            # pretest runs typecheck first

# Smoke-test the CLI running directly via Node strip-types
node --experimental-strip-types cli/orc.ts status
node --experimental-strip-types cli/orc.ts doctor
```

Audit for:
- Any `as any` casts — each is a gap to close
- Functions still returning `unknown` that could be typed
- Event builder call sites — compiler should reject missing required payload fields

---

## Key Conventions

- **No `any`.** Use `unknown` at JSON parse boundaries, narrow with type guards or AJV.
- **Schema is the source of truth.** If a type and its schema disagree, fix the type.
- **`Omit`/`Pick` over duplication.** e.g. `Omit<OrcEvent, 'seq'>` rather than a parallel interface.
- **Literal types for string enums.** `'todo' | 'claimed' | ...` not `string`.
- **State readers return typed state.** `readBacklog/readAgents/readClaims` are the `unknown` boundary.

---

## Migration Order Summary

```
Step 1: Setup (tsconfig, devdeps, scripts)          ~2h
Step 2: Generate + review schema types              ~3h
Step 3: Hand-write event discriminated union        ~3h
Step 4: Convert lib/ (zero-dep → stateful)          ~10h
Step 5: Convert cli/ (34 files)                     ~8h
Step 6: Convert mcp/                                ~3h
Step 7: Convert adapters/ + root                    ~3h
Step 8: Convert test files (deferrable)             ~8h
Step 9: Verify and harden                           ~3h
────────────────────────────────────────────────────
Total (excluding tests):                            ~35h
Total (including tests):                            ~43h
```
