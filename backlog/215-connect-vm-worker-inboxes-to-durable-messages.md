---
ref: isolagent-worker-runtime/215-connect-vm-worker-inboxes-to-durable-messages
feature: isolagent-worker-runtime
review_level: full
priority: normal
status: todo
depends_on:
  - vnext-control-plane/207-route-peer-review-and-human-messages
  - isolagent-worker-runtime/213-expose-the-scoped-worker-bridge-over-the-host-tunnel
  - isolagent-worker-runtime/214-integrate-isolagent-as-a-recoverable-worker-transport
---

# Task 215 — Connect VM worker inboxes to durable messages

Depends on Tasks 207, 213 and 214.

## Scope

Consume the durable typed peer and human messages supplied by existing Task 207 through the scoped worker bridge. Add worker inbox reads or long polling and consumption acknowledgements for a VM worker, so no inbound VM port or direct VM-to-VM proxy is needed. Deliver a peer review request from one isolated run to a second isolated run and bind its result to the initiating request. Reject cross-run reads, stale credentials, and duplicate consumption after reconnect. This task integrates the existing message store; it does not create a second message schema or router. Its backlog spec must explicitly depend on existing Task 207 in addition to the generated plan dependencies.

The message schema and router belong to Task 207; this task only connects isolated workers to them.

---

## Context

Task 207 supplies durable typed messages, but VM workers cannot consume them until the scoped guest bridge offers inbox and acknowledgement methods.

**Affected files:** `lib/controlProtocol.ts` and `lib/controlServer.ts`, `lib/controlClient.ts`, `lib/controlServer.test.ts` and message integration tests.

## Goals

1. Must let a VM worker list and consume only messages addressed to its active run and agent.
2. Must preserve correlation and idempotency across worker and daemon reconnects.
3. Must deliver a review request and result across two separate VMs without a VM-to-VM connection.

## Implementation

### Step 1 — `lib/controlProtocol.ts` and `lib/controlServer.ts`: add run-scoped inbox read, cursor or long-poll, and consumption ACK.

### Step 2 — `lib/controlClient.ts`: expose guest-side inbox and reply methods using the per-run credential.

### Step 3 — `lib/controlServer.test.ts` and message integration tests: two isolated actors, reconnect, duplicate ACK, and forbidden cross-run read.

## Acceptance criteria

- [ ] Worker A's review request reaches worker B and the correlated result reaches A after reconnect.
- [ ] Repeated delivery or ACK does not perform a completed action twice.
- [ ] A stale credential or worker from another run cannot read or acknowledge the inbox.
- [ ] No changes to files outside the stated scope.

## Tests

Fake two-worker bridge integration plus opt-in real two-VM review smoke; run `npm test` and `orc doctor`.

## Verification

`nvm use 24 && npm test`.

## Risk / Rollback

**Risk:** Message replay could duplicate review work or leak cross-run content.
**Rollback:** Disable VM inbox endpoints while preserving Task 207's durable records for recovery.
