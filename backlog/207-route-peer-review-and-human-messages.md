---
ref: vnext-control-plane/207-route-peer-review-and-human-messages
feature: vnext-control-plane
review_level: full
priority: normal
status: todo
depends_on:
  - vnext-control-plane/199-add-durable-command-delivery
  - vnext-control-plane/201-add-local-daemon-control-api
  - vnext-control-plane/203-integrate-structured-provider-runtimes
---

# Task 207 — Route peer review and human messages durably

Depends on Tasks 199, 201 and 203.

## Scope

**In scope:** Master/worker/peer/human semantic messages, question, review request, feedback and result types with delivery state.

**Out of scope:** Provider-private context sharing or huge transcript copying.

---

## Context

### Current state

Input requests and reviews exist as CLI/event workflows; peer messages are not durable first-class records.

### Desired state

Actors exchange scoped, acknowledged messages through daemon/SQLite, optionally referring to Git refs and artifacts.

### Start here

- `lib/runCommands.ts` — input requests.
- `cli/review-submit.ts` — reviews.

**Affected files:** message store/router, CLI/MCP handlers, tests.

---

## Goals

1. Must preserve existing blocker and review lifecycle while adding message IDs and consumption state.
2. Must enforce sender/recipient/run authorization.
3. Must support cross-provider worker review with explicit artifact references.

## Implementation

1. Add typed message records and route through command delivery.
2. Bridge existing input/review commands to message records behind compatibility readers.
3. Test duplicate delivery, stale recipient, unauthorized actor and two-provider review.

## Acceptance criteria

- [ ] Worker A requests review from Worker B and receives durable result after reconnect.
- [ ] Human response is bound to the correct request and run.
- [ ] Untrusted text cannot trigger a privileged control action.

## Tests

Fake-adapter cross-provider message and authorization integration tests.

## Verification

`npm test`; opt-in two-provider smoke.

## Risk / Rollback

**Risk:** Bridging duplicates old and new messages. **Rollback:** Use idempotency keys and retain old CLI path until parity is proved.
