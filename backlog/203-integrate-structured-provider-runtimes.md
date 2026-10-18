---
ref: vnext-control-plane/203-integrate-structured-provider-runtimes
feature: vnext-control-plane
review_level: full
priority: high
status: done
depends_on:
  - vnext-control-plane/195-prove-provider-and-terminal-protocols
  - vnext-control-plane/199-add-durable-command-delivery
  - vnext-control-plane/202-supervise-and-reconcile-agent-sessions
---

# Task 203 — Integrate subscription backed structured provider runtimes

Depends on Tasks 195, 199 and 202.

## Scope

**In scope:** Capability-based runtime contract, normalized events, and one proven provider end to end before adding the second.

**Out of scope:** Paid inference APIs and forcing Gemini to match unsupported capabilities.

---

## Context

### Current state

`AdapterInterface` is PTY-centric and `send` has no semantic acknowledgement. Provider-specific activity is mostly terminal text.

### Desired state

Supported structured providers emit lifecycle/approval/turn events and ACK commands when their protocol proves acceptance; PTY remains fallback.

### Start here

- `adapters/interface.ts` — current contract.
- `adapters/pty.ts` — fallback.

**Affected files:** runtime interface, Codex/Claude adapters conditional on Task 195 evidence, fake adapter and tests.

---

## Goals

1. Must declare capabilities rather than assume resume, steering, interrupt or approval support.
2. Must normalize session/turn/tool/approval/command events while retaining provider metadata.
3. Must use demonstrated subscription authentication and reject an unverified API-key billing path.

## Implementation

1. Introduce runtime contract and fake adapter with partial-frame/late-event tests.
2. Integrate one proven local protocol into command queue and session supervisor.
3. Add the second only after first end-to-end lifecycle, blocker and completion pass; keep CLI fallback.

## Acceptance criteria

- [x] One provider can claim, ACK, work, ask, receive response and finish through durable commands.
- [x] Second provider passes equivalent opt-in smoke or remains an explicit CLI fallback.
- [x] Unsupported capability returns a typed refusal; no silent API billing change.

## Tests

Fake-adapter protocol and lifecycle tests; opt-in real-provider smoke matrix.

## Verification

`npm test`; opt-in smoke documented by Task 195.

## Risk / Rollback

**Risk:** Provider protocol/auth changes. **Rollback:** Select legacy CLI adapter by configuration; preserve run history and mark uncertain commands explicitly.
