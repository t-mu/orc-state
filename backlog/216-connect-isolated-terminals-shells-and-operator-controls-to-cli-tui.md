---
ref: isolagent-worker-runtime/216-connect-isolated-terminals-shells-and-operator-controls-to-cli-tui
feature: isolagent-worker-runtime
review_level: full
priority: normal
status: cancelled
depends_on:
  - isolagent-worker-runtime/214-integrate-isolagent-as-a-recoverable-worker-transport
  - isolagent-worker-runtime/215-connect-vm-worker-inboxes-to-durable-messages
---

# Task 216 — Connect isolated terminals, shells, and operator controls to CLI/TUI

**Cancelled:** Isolagent integration and the desktop client will be developed outside the public orc-state repository. This spec is retained as historical design context and must not be dispatched here.

Depends on Tasks 214, and 215.

## Scope

Bridge isolagent's output, input, resize, and reconnect capabilities into `lib/terminalBroker.ts`; preserve read-only observers and exclusive writer leases. Open a separate `/work` shell without stealing the provider terminal. Surface approval requests, egress denials, and VM failures through the daemon and existing CLI/TUI controls. Verify attach/detach, two-writer contention, CLI/TUI restart, and continued worker execution with the TUI closed.

**Out of scope:** Desktop UI and direct terminal sharing between VMs.

---

## Context

The existing terminal broker handles host-side sessions. Isolagent exposes a guest terminal stream, but CLI/TUI attach, shell, resize, and exclusive input leases must work through the VM adapter.

**Affected files:** `lib/terminalBroker.ts`, CLI attach/shell commands and `lib/tui/`, `lib/terminalBroker.test.ts`.

## Goals

1. Must support read-only attach, scrollback, resize, and exclusive writer leases for a VM provider terminal.
2. Must open an independent `/work` shell without interrupting the provider session.
3. Must show VM failures, egress denials, and approval requests through CLI/TUI while workers survive UI exit.

## Implementation

### Step 1 — `lib/terminalBroker.ts`: register VM terminal and shell streams with the existing lease model.

### Step 2 — CLI attach/shell commands and `lib/tui/`: route isolated session controls through the daemon.

### Step 3 — `lib/terminalBroker.test.ts`: reconnect, two writers, independent shell, and provider exit cases.

## Acceptance criteria

- [ ] Closing and reopening CLI/TUI preserves a healthy worker and its output history.
- [ ] A second writer is denied; an observer can attach without taking input ownership.
- [ ] An independent shell opens in the correct worktree and does not consume provider input.
- [ ] No changes to files outside the stated scope.

## Tests

Fake broker tests plus opt-in real VM CLI/TUI attach and shell smoke; run `npm test`.

## Verification

`nvm use 24 && npm test`.

## Risk / Rollback

**Risk:** Broker ownership errors could send input to the wrong VM session.
**Rollback:** Force VM terminals read-only until ownership is repaired.
