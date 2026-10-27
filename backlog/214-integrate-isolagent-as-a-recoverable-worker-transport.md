---
ref: isolagent-worker-runtime/214-integrate-isolagent-as-a-recoverable-worker-transport
feature: isolagent-worker-runtime
review_level: full
priority: normal
status: cancelled
depends_on:
  - isolagent-worker-runtime/211-add-a-headless-reconnectable-isolagent-supervisor-interface
  - isolagent-worker-runtime/212-package-isolated-worker-flavors-and-fail-closed-preflight
  - isolagent-worker-runtime/213-expose-the-scoped-worker-bridge-over-the-host-tunnel
---

# Task 214 — Integrate isolagent as a recoverable worker transport

**Cancelled:** Isolagent integration and the desktop client will be developed outside the public orc-state repository. This spec is retained as historical design context and must not be dispatched here.

Depends on Tasks 211, 212, and 213.

## Scope

Add an isolagent transport to `adapters/index.ts` and `lib/workerRuntime.ts` with start, send, output tail, attach, probe, stop, and session inspection. Persist VM instance identity separately from provider session and run IDs. Reconcile live VM/guest process state after daemon restart, host sleep, and stale supervisor metadata; preserve healthy workers and mark uncertain ownership recoverable rather than redispatching. Support attached and sibling layouts, and leave the existing host PTY, tmux, structured, and project-container paths intact. Test two concurrent worktrees and failure cleanup.

**Out of scope:** Replacing existing host provider transports or changing Git finalization ownership.

---

## Context

The adapter factory routes CLI, tmux, and Codex app-server sessions. It has no VM transport or persisted VM identity, so a daemon restart cannot safely adopt an isolated worker.

**Affected files:** `adapters/index.ts` and new `adapters/isolagent.ts`, `lib/workerRuntime.ts` and `lib/sessionSupervisor.ts`, `adapters/isolagent.test.ts` and `lib/sessionSupervisor.test.ts`.

## Goals

1. Must launch each claimed worker in its assigned worktree VM and persist VM and guest session identities separately.
2. Must implement send, output, probe, inspect, stop, and recoverable states through the adapter contract.
3. Must preserve host transports, attached/sibling layouts, and two-worker concurrency.

## Implementation

### Step 1 — `adapters/index.ts` and new `adapters/isolagent.ts`: route opaque VM handles and implement the adapter contract.

### Step 2 — `lib/workerRuntime.ts` and `lib/sessionSupervisor.ts`: start from the assigned worktree, persist VM identity, and reconcile after restart.

### Step 3 — `adapters/isolagent.test.ts` and `lib/sessionSupervisor.test.ts`: fake supervisor and two-worktree failure tests.

## Acceptance criteria

- [ ] Two workers occupy distinct VMs and worktrees; neither receives another run's handle.
- [ ] A daemon restart leaves a healthy VM visible and writable; an uncertain owner is recoverable, not redispatched.
- [ ] A failed VM launch releases only that attempt and reports the cause.
- [ ] No changes to files outside the stated scope.

## Tests

Add fake-supervisor adapter, restart, stale handle, and sibling-layout tests; run `npm test` and opt-in two-VM smoke.

## Verification

`nvm use 24 && npm test`.

## Risk / Rollback

**Risk:** Wrong VM adoption can deliver commands to another run.
**Rollback:** Disable the isolagent transport and retain existing host transports.
