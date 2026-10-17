---
ref: vnext-control-plane/198-migrate-run-transitions-transactionally
feature: vnext-control-plane
review_level: full
priority: high
status: todo
depends_on:
  - vnext-control-plane/197-add-versioned-runtime-schema
  - vnext-control-plane/196-pin-markdown-task-revisions
---

# Task 198 — Migrate run transitions transactionally

Depends on Tasks 196 and 197.

## Scope

**In scope:** SQLite authority for run claim, start, failure, completion and session identity; compatibility readers for old JSON state.

**Out of scope:** Rewriting scheduler priorities, Git finalization or task Markdown.

---

## Context

### Current state

`lib/claimManager.ts` updates multiple JSON files and appends an event afterward, so a crash can expose partial state.

### Desired state

Run transition and event append commit together. Legacy states import once; JSON becomes a derived compatibility view for migrated fields.

### Start here

- `lib/claimManager.ts` — lifecycle transitions.
- `lib/agentRegistry.ts` — session state.

**Affected files:** runtime transition store, claim/agent readers, compatibility projection, tests.

---

## Goals

1. Must make each run transition and event one SQLite transaction.
2. Must enforce one active claim per task and separate stable agent, run and provider session IDs.
3. Must prevent two authoritative writers for any migrated field.

## Implementation

1. Import legacy claims/agents idempotently and define a documented cutover marker.
2. Route lifecycle commands through transactional reducers while preserving their CLI signatures.
3. Project compatibility JSON only where older readers require it; test crash points and rollback.

## Acceptance criteria

- [ ] Crash injection cannot produce a committed transition without its event, or vice versa.
- [ ] Duplicate claim attempts cannot create two active runs.
- [ ] Existing CLI/TUI and direct/PR finalization tests continue to pass.

## Tests

Add transition, import, duplicate claim and crash injection integration tests.

## Verification

`npm test`; `orc doctor` against imported and fresh test state.

## Risk / Rollback

**Risk:** Mixed old/new writers diverge. **Rollback:** Restore database and JSON backup from before cutover; disable new writer, then run reconciliation. Never run both writers indefinitely.
