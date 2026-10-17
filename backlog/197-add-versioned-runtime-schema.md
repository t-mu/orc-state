---
ref: vnext-control-plane/197-add-versioned-runtime-schema
feature: vnext-control-plane
review_level: full
priority: high
status: done
depends_on:
  - vnext-control-plane/209-allocate-event-sequences-atomically
---

# Task 197 — Add a versioned SQLite runtime schema

Depends on Task 209.

## Scope

**In scope:** Versioned migrations for runs, sessions, commands, messages/input requests, offsets and control leases in existing `events.db`.

**Out of scope:** Switching existing JSON writers or dispatch semantics.

---

## Context

### Current state

Only events are in `events.db`; claims, agents, worktrees, and checkpoints are separate files.

### Desired state

Operational tables exist with constraints, migration history, backup/rollback guidance, and legacy readers still work.

### Start here

- `lib/eventLog.ts` — SQLite connection and WAL.
- `lib/stateInit.ts` — state creation.

**Affected files:** runtime store/migrations, `lib/stateInit.ts`, `cli/doctor.ts`, tests.

---

## Goals

1. Must define stable IDs, foreign keys and unique idempotency constraints.
2. Must apply each schema migration atomically and refuse unknown future versions.
3. Must preserve event FTS and existing JSON-based lifecycle.

## Implementation

1. Add migration runner and initial operational tables to the existing database.
2. Add `orc doctor` checks and documented backup/recovery procedure.
3. Test fresh install, upgrade from current DB, interrupted migration, and version mismatch.

## Acceptance criteria

- [ ] Existing repository state upgrades without lost events.
- [ ] Repeated migration is a no-op; partial migration rolls back.
- [ ] No CLI or worker behavior changes before explicit cutover.

## Tests

Add migration tests using copied legacy fixtures and a forced transaction failure.

## Verification

`npm test`; `orc doctor` on fresh and upgraded test states.

## Risk / Rollback

**Risk:** Database migration blocks startup. **Rollback:** Restore the documented pre-migration database backup and previous binary; do not silently downgrade tables.
