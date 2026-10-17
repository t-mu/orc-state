---
ref: vnext-control-plane/201-add-local-daemon-control-api
feature: vnext-control-plane
review_level: full
priority: high
status: todo
depends_on:
  - vnext-control-plane/198-migrate-run-transitions-transactionally
  - vnext-control-plane/199-add-durable-command-delivery
  - vnext-control-plane/200-use-durable-event-cursors
---

# Task 201 — Add a versioned local daemon control API

Depends on Tasks 198, 199 and 200.

## Scope

**In scope:** Authenticated snapshot, event subscription and scoped command endpoints, with a CLI client path.

**Out of scope:** Desktop renderer and a second scheduler.

---

## Context

### Current state

CLI and MCP handlers read state files or call library functions directly. No separate client can reconnect to a stable daemon contract.

### Desired state

One daemon owns mutations; clients obtain a consistent snapshot and resume events from a cursor over a versioned local protocol.

### Start here

- `coordinator.ts` — daemon loop.
- `mcp/handlers.ts` — existing read/command behavior.

**Affected files:** control server/client, status projection, CLI/MCP adapters, tests.

---

## Goals

1. Must bind only to a local authenticated transport and enforce actor/run scope.
2. Must version requests/responses and support snapshot followed by cursor subscription without gaps.
3. Must preserve existing CLI/MCP behavior during migration.

## Implementation

1. Extract status projection and command services from direct handlers.
2. Expose read/command methods and live events through the selected transport from Task 195.
3. Route one CLI read and one CLI command through the client as a vertical slice; expand only after contract tests pass.

## Acceptance criteria

- [ ] Separate client lists runs, reads an event cursor and submits an allowed command.
- [ ] Unauthenticated or cross-run mutation is rejected.
- [ ] Reconnect sees all events after the snapshot cursor.

## Tests

Add protocol contract tests with two client processes, reconnect and authorization failures.

## Verification

`npm test`; `orc doctor`; CLI smoke for old and new paths.

## Risk / Rollback

**Risk:** Server outage blocks control. **Rollback:** Retain legacy CLI entry points until control API parity is demonstrated; daemon remains sole writer for migrated state.
