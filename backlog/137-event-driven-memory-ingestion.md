---
ref: memory-access/137-event-driven-memory-ingestion
feature: memory-access
priority: normal
status: todo
depends_on:
  - memory-foundation/129-drawer-crud-spatial-coordinates
  - memory-foundation/130-duplicate-detection-keyword-tags
---

# Task 137 — Add Event-Driven Memory Ingestion

Depends on Tasks 129 and 130.

## Scope

**In scope:**
- Direct `storeDrawer()` calls at coordinator event emission sites for `run_finished`, `run_failed`, `input_response`
- `storeDrawer()` call in `cli/review-submit.ts` for review findings
- Wing inference from task_ref feature prefix
- Source tracking via sourceType/sourceRef fields

**Out of scope:**
- PTY log parsing or heuristic mining
- MCP tool exposure for ingestion (workers use `orc memory-record` directly)
- Pub/sub or event bus abstraction — direct calls only

---

## Context

### Current state

The coordinator emits lifecycle events (run_finished, run_failed, etc.) to events.db.
Review findings are recorded via `cli/review-submit.ts`. None of these flows create
memory drawers. Task outcomes, errors, and decisions are lost to workers in future sessions.

### Desired state

Key lifecycle events automatically create memory drawers:
- Task completions → outcomes wing, importance 5
- Task failures → errors wing, importance 8
- Input Q&A → decisions wing, importance 7
- Review findings → review-findings room, importance 6

### Start here

- `coordinator.ts` — sites that emit `run_finished` and `run_failed` events
- `cli/run-input-respond.ts` — where `input_response` event is emitted (NOT coordinator.ts)
- `cli/review-submit.ts` — where review findings are recorded
- `lib/memoryStore.ts` — `storeDrawer()` function

**Affected files:**
- `coordinator.ts` — add `storeDrawer()` calls at `run_finished` and `run_failed` emission sites
- `cli/run-input-respond.ts` — add `storeDrawer()` call after `input_response` event emission
- `cli/review-submit.ts` — add `storeDrawer()` call for review findings
- `lib/memoryStore.ts` — add `wingFromTaskRef()` helper

---

## Goals

1. Must store a memory drawer on `run_finished` with task outcome summary.
2. Must store a memory drawer on `run_failed` with failure reason (importance 8).
3. Must store a memory drawer on `input_response` with question+answer pair (importance 7).
4. Must store a memory drawer in `review-submit.ts` for review findings (importance 6).
5. Must infer wing from task_ref feature prefix (e.g., `e2e-real/127-*` → `e2e-real`; fallback `general`).
6. Must set sourceType to `event` and sourceRef to run_id or event_id.
7. Must fail silently if memory.db is not initialized (try/catch around storeDrawer).

---

## Implementation

### Step 1 — Add wing inference helper

**File:** `lib/memoryStore.ts`

```ts
export function wingFromTaskRef(taskRef: string): string {
  const slash = taskRef.indexOf('/');
  return slash > 0 ? taskRef.slice(0, slash) : 'general';
}
```

### Step 2 — Add memory ingestion at coordinator event sites

**File:** `coordinator.ts`

At the site that emits `run_finished`:
```ts
try {
  storeDrawer(STATE_DIR, {
    wing: wingFromTaskRef(claim.task_ref),
    hall: 'outcomes', room: 'task-completions',
    content: `Task ${claim.task_ref} completed by ${claim.agent_id} (run ${claim.run_id})`,
    importance: 5, sourceType: 'event', sourceRef: claim.run_id,
  });
} catch { /* memory system not initialized — silently skip */ }
```

Similar pattern for `run_failed` (hall=`errors`, room=`run-failures`, importance=8).

### Step 3 — Add memory ingestion in run-input-respond.ts

**File:** `cli/run-input-respond.ts`

After the `input_response` event is emitted (this is where input responses are recorded,
NOT in coordinator.ts):
```ts
try {
  storeDrawer(stateDir, {
    wing: wingFromTaskRef(taskRef),
    hall: 'decisions', room: 'master-input',
    content: `Q: ${question}\nA: ${response}`,
    importance: 7, sourceType: 'event', sourceRef: runId,
  });
} catch { /* memory system not initialized — silently skip */ }
```

### Step 4 — Add memory ingestion in review-submit.ts

**File:** `cli/review-submit.ts`

After recording the review event, store findings as a memory drawer:
```ts
try {
  if (outcome === 'findings' && reason) {
    storeDrawer(stateDir, {
      wing: wingFromTaskRef(taskRef),
      hall: 'reviews', room: 'review-findings',
      content: reason,
      importance: 6, sourceType: 'review', sourceRef: runId,
    });
  }
} catch { /* memory system not initialized */ }
```

---

## Acceptance criteria

- [ ] Completing a task creates a memory drawer with hall=`outcomes`
- [ ] Failing a task creates a memory drawer with hall=`errors` and importance=8
- [ ] Input request+response creates a memory drawer with hall=`decisions` and importance=7
- [ ] Review findings create a memory drawer with hall=`reviews` and importance=6
- [ ] Wing is correctly inferred from task_ref feature prefix
- [ ] All ingestion calls fail silently when memory.db is not initialized
- [ ] Duplicate content is not re-inserted (relies on Task 130's content hash check)
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('wingFromTaskRef extracts feature prefix', () => { ... });
it('wingFromTaskRef falls back to general for refs without slash', () => { ... });
```

Add to `coordinator.test.ts`:

```ts
it('stores memory drawer on run_finished event', () => { ... });
it('stores memory drawer on run_failed event with importance 8', () => { ... });
it('silently skips memory storage when memory.db not initialized', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts coordinator.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Adding `storeDrawer()` calls to coordinator.ts introduces a dependency on the memory module in the coordinator's critical path. If `storeDrawer()` throws despite the try/catch, the coordinator tick could fail.
**Rollback:** `git restore coordinator.ts cli/review-submit.ts && npm test`
