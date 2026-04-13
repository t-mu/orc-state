---
ref: dynamic-workers/171-ephemeral-worker-naming-and-capacity
feature: dynamic-workers
review_level: full
priority: high
status: done
---

# Task 171 — Introduce Deterministic Ephemeral Worker Naming and Shared Capacity

Independent. Blocks Task 172.

## Scope

**In scope:**
- Replace synthetic managed worker slots with a computed capacity model based on configured concurrency and live worker agents/sessions.
- Add deterministic two-word worker naming for live task-scoped workers with uniqueness enforced among active workers only.
- Remove slot-specific agent registry behavior that manufactures persistent idle workers like `orc-1`.
- Introduce a shared capacity helper used by runtime dispatch and operator/status surfaces so capacity is derived in one place.
- Update tests around agent registration, capacity accounting, and worker cleanup expectations.

**Out of scope:**
- Dispatch-time provider selection and task claim routing changes in the coordinator.
- TUI, `orc watch`, status presentation, and operator-facing docs.
- PR finalization, scout behavior, or master-session lifecycle changes.

---

## Context

The current worker architecture models capacity as long-lived synthetic slots, which are registered as idle or running agents and reused across many unrelated tasks. That makes the runtime state harder to reason about, pollutes logs under reused worker IDs, and blocks mixed-provider execution because the slot itself carries a single provider identity.

The target model is task-scoped workers. `max_workers` should mean concurrency only, not pre-created idle worker records. Worker identities should exist only while a live session exists, and each live session should get a deterministic human-readable two-word name such as `amber-kettle`.

This task establishes the new baseline the rest of the refactor depends on: no permanent slot records, deterministic ephemeral worker IDs, and one shared capacity calculation derived from live worker agents/sessions rather than synthetic worker inventory.

**Start here:**
- `lib/agentRegistry.ts` — current managed-slot creation and reconciliation logic
- `lib/taskScheduler.ts` — scheduling assumptions that may still depend on slot-oriented agents
- `types/agents.ts` — current agent shape and any slot-specific fields
- `lib/statusView.ts` or shared status helpers — consumers that must use the same capacity helper

**Affected files:**
- `lib/agentRegistry.ts` — remove synthetic slot reconciliation and register only live agents
- `lib/taskScheduler.ts` — stop assuming idle slot agents exist
- `types/agents.ts` — ensure agent shape matches ephemeral live-worker semantics
- `lib/agentNames.ts` — new deterministic name allocator
- `lib/workerCapacity.ts` — new shared helper for live-worker capacity calculation
- `lib/status.ts` or equivalent runtime summary helpers — adopt shared capacity helper instead of slot count
- `*.test.ts` under `lib/` and `cli/` — update slot-oriented expectations

---

## Goals

1. Must remove runtime creation and maintenance of synthetic idle worker slot records.
2. Must represent worker capacity as configured concurrency plus currently live worker agents/sessions, not as registered idle workers or only active run rows.
3. Must allocate deterministic two-word worker names from fixed local word lists with no randomness or numeric suffixes.
4. Must ensure active live-worker names are unique under the runtime state lock.
5. Must allow names to be reused after a worker is fully removed from active runtime state.
6. Must provide one shared capacity helper that dispatch/runtime and status/operator views can both call.
7. Must preserve non-worker agent handling for master and scout flows.

---

## Implementation

### Step 1 — Add deterministic live-worker name allocation

**File:** `lib/agentNames.ts`

Create a small local allocator with two fixed 64-item word lists and a deterministic first-unused search:

```ts
export function nextAvailableAgentName(inUse: ReadonlySet<string>): string {
  for (const first of FIRST_WORDS) {
    for (const second of SECOND_WORDS) {
      const candidate = `${first}-${second}`;
      if (!inUse.has(candidate)) return candidate;
    }
  }
  throw new Error('exhausted agent name pool');
}
```

Keep the lists local to the repo. Do not add external dependencies or random fallback logic.

### Step 2 — Remove synthetic managed-slot registration

**File:** `lib/agentRegistry.ts`

Delete or replace the code path that reconciles idle `orc-N` worker slots into `agents.json`. Registration should happen only when a real live worker session is being launched, and cleanup should remove that agent record entirely when the session is gone.

Preserve existing behavior for master/scout agents. The change is specifically about worker capacity and worker records.

### Step 3 — Compute shared capacity from live workers instead of idle slots

**Files:** `lib/workerCapacity.ts`, `lib/agentRegistry.ts`, `lib/taskScheduler.ts`, any shared runtime status helpers

Replace slot-count logic with computed capacity:

```ts
availableCapacity = maxWorkers - activeLiveWorkerCount;
```

Count live worker agents/sessions, including booting or just-registered workers that already consume concurrency even if they have not emitted `run-start` yet. Audit all helpers that currently derive availability from the count of registered idle workers and convert them to use the same shared helper instead.

### Step 4 — Update runtime tests to the new model

**Files:** `lib/agentRegistry.test.ts`, `lib/taskScheduler.test.ts`, related status/doctor tests

Rewrite tests that expect persistent `orc-1`, `orc-2`, ... workers. Replace them with assertions about:
- no synthetic idle worker records
- deterministic live-worker naming
- name reuse after removal
- capacity computed from active runs

---

## Acceptance criteria

- [ ] No code path manufactures persistent idle worker slot records.
- [ ] Worker capacity is computed from configured `max_workers` and active live worker agents/sessions, including booting workers.
- [ ] New live workers receive deterministic two-word names from fixed local word lists.
- [ ] Active live-worker names are unique without random strings, counters, or UUID suffixes.
- [ ] Removing a live worker frees its name for later reuse.
- [ ] Dispatch/runtime code and status/operator-facing helpers use the same shared capacity calculation.
- [ ] Master and scout agent behavior remains unchanged.
- [ ] Tests no longer assert the existence of persistent `orc-N` worker slots.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update tests in `lib/agentRegistry.test.ts`:

```ts
it('does not synthesize idle worker slots when max_workers is configured', () => { ... });
it('allocates the first unused deterministic two-word worker name', () => { ... });
it('reuses a worker name only after the prior live worker is removed', () => { ... });
```

Add or update tests in `lib/taskScheduler.test.ts`:

```ts
it('computes available worker capacity from active live workers instead of idle slots or only started runs', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/agentRegistry.test.ts lib/taskScheduler.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Capacity accounting or cleanup could strand live runs, over-dispatch work, or remove worker records too early.
**Rollback:** `git restore lib/agentRegistry.ts lib/taskScheduler.ts types/agents.ts lib/agentNames.ts && npm test`
