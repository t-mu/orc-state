---
ref: vnext-control-plane/199-add-durable-command-delivery
feature: vnext-control-plane
review_level: full
priority: high
status: todo
depends_on:
  - vnext-control-plane/197-add-versioned-runtime-schema
---

# Task 199 — Add durable scoped command delivery

Depends on Task 197.

## Scope

**In scope:** Queue records, idempotent enqueue, state transitions, bounded retry, timeouts, and reconciliation using a fake provider.

**Out of scope:** Real structured provider adapters and replacing every existing PTY send.

---

## Context

### Current state

Provider `send()` resolves after input write, while lifecycle and responses are inferred from later events. A crash between intent and send has no durable command record.

### Desired state

Commands record queued, dispatching, sent, accepted, running, completed, failed, cancelled or outcome_unknown. Only semantic provider/worker evidence counts as acceptance.

### Start here

- `adapters/interface.ts` — current send semantics.
- `lib/runCommands.ts` — worker input path.

**Affected files:** command queue/dispatcher, fake runtime, tests.

---

## Goals

1. Must scope commands to an authenticated actor, recipient and run.
2. Must dedupe by command/idempotency key and distinguish transport send from semantic ACK.
3. Must never blindly replay a possibly executed side-effecting command after a crash.

## Implementation

1. Add transactional enqueue and status transitions with corresponding events.
2. Add wakeup plus periodic sweep and a dispatcher that uses fake adapter acknowledgements.
3. Reconcile uncertain deliveries as `outcome_unknown` and require explicit operator action where execution cannot be proved.

## Acceptance criteria

- [ ] Crash before send can retry safely; crash after possible send does not double-execute a side effect.
- [ ] Duplicate key creates one command; PTY write reaches only `sent`.
- [ ] Timeout and provider exit yield explicit terminal or unknown states.

## Tests

Add deterministic subprocess/fake-adapter cases for disconnect, duplicate, timeout and late ACK.

## Verification

`npm test`; `orc doctor` against test state.

## Risk / Rollback

**Risk:** A stuck dispatcher hides queued work. **Rollback:** Keep existing CLI path until the new queue is exercised end-to-end; preserve command rows for inspection.
