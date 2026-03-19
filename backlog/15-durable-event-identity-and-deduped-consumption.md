---
ref: general/15-durable-event-identity-and-deduped-consumption
feature: general
priority: high
status: done
---

# Task 15 — Replace Seq-Based Event Consumption with Durable Event Identity

Independent. Blocks Task 16.

## Scope

**In scope:**
- Define a durable event identity model for append-only events that does not depend on strict global `seq` ordering for correctness
- Update coordinator-side event consumption to dedupe and checkpoint by event identity instead of `seq > afterSeq`
- Keep worker append semantics append-only and compatible with concurrent writers
- Add the minimum state needed for safe replay and coordinator restarts

**Out of scope:**
- Backlog/spec sync behavior and markdown authority rules
- Doctor/status/operator messaging changes beyond what the new event model strictly requires
- Broad reducer extraction or workflow simplification

---

## Context

The current event log model still treats `seq` as the primary correctness boundary even though the system now relies on multiple appenders. That leaves the coordinator exposed to skipped events, duplicate processing, or fragile replay behavior under concurrent writes and restarts.

### Current state

Worker lifecycle commands now emit append-only events, but coordinator consumption still assumes a globally serialized sequence is sufficient to determine what has and has not been handled. That assumption is weaker than the runtime model and creates unnecessary coupling between append order and correctness.

### Desired state

The coordinator should consume events by durable identity, apply them idempotently, and persist a replay-safe checkpoint that tolerates duplicates, restarts, and concurrent appends. `seq` may remain as an ordering hint, but it must no longer be the sole correctness contract.

### Start here

- `lib/eventLog.ts` — inspect the current event shape, append path, and cursor assumptions
- `coordinator.ts` — inspect the event consumption loop and persisted processing state
- `types/events.ts` — confirm the current event contract and where to extend it safely

**Affected files:**
- `lib/eventLog.ts` — event identity generation and read helpers
- `coordinator.ts` — deduped consumption and checkpoint persistence
- `types/events.ts` — durable event identity fields and types
- `schemas/*.json` — only if persisted processing state or event schema must change

---

## Goals

1. Must replace strict `seq`-only coordinator consumption with identity-based dedupe and replay-safe checkpointing.
2. Must preserve append-only multi-writer event logging without introducing a central event broker.
3. Must keep coordinator processing idempotent across duplicate or re-read events.
4. Must persist enough processing state for safe restart recovery.
5. Must avoid unrelated workflow, backlog, or documentation changes.

---

## Implementation

### Step 1 — Define the durable event identity contract

**File:** `types/events.ts`

Add the event identity fields and invariants needed for replay-safe dedupe. Keep the contract explicit about which field is authoritative for uniqueness and which fields remain informational.

### Step 2 — Update event append/read helpers

**File:** `lib/eventLog.ts`

Generate or validate durable event identities at append time and expose read helpers that support identity-based replay instead of relying on contiguous `seq` processing alone.

### Step 3 — Rework coordinator consumption

**File:** `coordinator.ts`

Replace `seq`-only cursor logic with identity-aware consumption and persisted checkpointing. Preserve existing lifecycle semantics while making duplicate processing safe.

### Step 4 — Update any persisted schema or state helpers

**File:** `schemas/*.json`

If the coordinator persists processed-event metadata or a new checkpoint structure, update the schema and validation layer to match the new model.

---

## Acceptance criteria

- [ ] Coordinator event consumption no longer relies on `seq > afterSeq` as the sole correctness boundary.
- [ ] Re-reading an already processed event does not reapply the same lifecycle transition.
- [ ] Concurrently appended events remain visible to the coordinator without requiring a single global writer.
- [ ] Coordinator restart can resume event processing from persisted identity-aware state.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `coordinator.test.ts` and `lib/eventLog.test.ts`:

```ts
it('dedupes already processed events by durable identity', () => { ... });
it('resumes safely after restart with persisted processing state', () => { ... });
it('does not skip valid concurrent appends when seq ordering is not the sole cursor', () => { ... });
```

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run coordinator.test.ts lib/eventLog.test.ts
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
orc doctor
orc status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** A partially correct dedupe model can hide legitimate events or replay stale ones, which would corrupt run lifecycle transitions.
**Rollback:** Revert the event identity and coordinator checkpoint changes together, restore the prior persisted processing format from git, and re-run `orc doctor`.
