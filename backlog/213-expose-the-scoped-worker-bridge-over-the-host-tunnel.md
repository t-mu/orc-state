---
ref: isolagent-worker-runtime/213-expose-the-scoped-worker-bridge-over-the-host-tunnel
feature: isolagent-worker-runtime
review_level: full
priority: normal
status: todo
depends_on:
  - isolagent-worker-runtime/210-specify-and-prove-the-isolated-runtime-boundary
---

# Task 213 — Expose the scoped worker bridge over the host tunnel

Depends on Task 210.

## Scope

Add an authenticated loopback TCP endpoint to the daemon, reachable only through one explicitly configured isolagent guest-to-host tunnel port. Issue a random per-run worker credential at launch; bind it to agent ID, run ID, expiry, and revocation on terminal run state. Implement the minimum lifecycle, message, and read endpoints required by the guest `orc` client, without mounting `.orc-state` into VMs or forwarding the daemon's operator token. Reject cross-run mutation, forged sender fields, expired credentials, and operator-only methods. Test connected and disconnected behavior, including daemon restart.

**Out of scope:** Operator control endpoints and direct access to host SQLite from a guest.

---

## Context

The current daemon endpoint is a Unix socket with a broad bearer token, and session IDs are explicitly not a security boundary. A VM needs a narrow lifecycle/message path over isolagent's allowed host-port tunnel.

**Affected files:** `lib/controlProtocol.ts` and `lib/controlServer.ts`, `lib/controlClient.ts` and `lib/workerRuntime.ts`, `lib/sessionState.ts` or the runtime store.

## Goals

1. Must bind the worker bridge to host loopback and require a distinct run-scoped secret.
2. Must authorize every method against active run and agent identity, with revocation at run end.
3. Must reject operator methods, forged sender fields, stale credentials, and cross-run reads or writes.

## Implementation

### Step 1 — `lib/controlProtocol.ts` and `lib/controlServer.ts`: add a worker-only TCP surface and typed request/response errors.

### Step 2 — `lib/controlClient.ts` and `lib/workerRuntime.ts`: issue and deliver a random per-run credential without forwarding the operator bearer token.

### Step 3 — `lib/sessionState.ts` or the runtime store: persist credential verifier and revoke on terminal transition; never log raw secrets.

## Acceptance criteria

- [ ] The VM completes lifecycle requests through one configured isolagent tunnel port.
- [ ] Cross-run and operator requests return forbidden; revoked credentials fail after completion and restart.
- [ ] No `.orc-state` share or daemon operator token is present in the VM.
- [ ] No changes to files outside the stated scope.

## Tests

Add auth, stale-run, restart, and loopback binding tests in `lib/controlServer.test.ts`; run `npm test` and `orc doctor`.

## Verification

`nvm use 24 && npm test`; `orc doctor`.

## Risk / Rollback

**Risk:** A bridge authorization bug can let a compromised worker control other runs.
**Rollback:** Disable the TCP worker listener and revert to host worker transport until authorization is repaired.
