---
ref: vnext-control-plane/202-supervise-and-reconcile-agent-sessions
feature: vnext-control-plane
review_level: full
priority: high
status: todo
depends_on:
  - vnext-control-plane/198-migrate-run-transitions-transactionally
  - vnext-control-plane/195-prove-provider-and-terminal-protocols
---

# Task 202 — Supervise and reconcile agent sessions

Depends on Tasks 195 and 198.

## Scope

**In scope:** Session identity, ownership, process metadata, restart adoption/resume and explicit recoverable status.

**Out of scope:** Provider-specific structured event parsing and terminal UI.

---

## Context

### Current state

PTY handles live in coordinator memory and PID files only establish liveness. A coordinator restart can leave an alive process that it cannot send to.

### Desired state

Session supervision is separate from coordinator scheduling or has a proven resume path; restart reconciles actual process and durable metadata.

### Start here

- `lib/workerRuntime.ts` — launch.
- `adapters/pty.ts` — process ownership.

**Affected files:** session supervisor, runtime store, reconciliation and tests.

---

## Goals

1. Must distinguish stable agent ID, run ID and unique provider session ID.
2. Must not kill healthy workers merely because coordinator restarted.
3. Must mark unreachable or ambiguous sessions recoverable/unknown with a reason.

## Implementation

1. Persist process/session metadata and ownership lease.
2. Implement resume/adopt or explicit recovery per transport capability.
3. Test coordinator crash, supervisor crash, stale PID reuse and provider exit.

## Acceptance criteria

- [ ] Coordinator restart keeps a healthy session running and visible.
- [ ] Unowned live process is not falsely reported as writable.
- [ ] Failed adoption has a clear operator recovery state.

## Tests

Add fake subprocess restart and PID reuse integration tests.

## Verification

`npm test`; manual opt-in live-session restart smoke.

## Risk / Rollback

**Risk:** Incorrect adoption sends commands to the wrong process. **Rollback:** Disable adoption and expose explicit recoverable status; do not redispatch automatically.
