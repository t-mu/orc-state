---
ref: isolagent-worker-runtime/217-prove-the-cli-tui-isolation-gate-and-block-desktop-until-it-passes
feature: isolagent-worker-runtime
review_level: full
priority: normal
status: cancelled
depends_on:
  - isolagent-worker-runtime/215-connect-vm-worker-inboxes-to-durable-messages
  - isolagent-worker-runtime/216-connect-isolated-terminals-shells-and-operator-controls-to-cli-tui
---

# Task 217 — Prove the CLI/TUI isolation gate and block desktop until it passes

**Cancelled:** Isolagent integration and the desktop client will be developed outside the public orc-state repository. This spec is retained as historical design context and must not be dispatched here.

Depends on Tasks 215, and 216.

## Scope

Add an opt-in end-to-end test that uses only CLI/TUI and the daemon to run two concurrent isolated workers, exchange a peer review and human reply, restart the daemon, recover both VM sessions, open an independent shell, and finalize Git worktrees. Run the proof on supported macOS and Linux hosts, with a documented provider/flavor matrix and failure evidence. Existing Task 208 must already depend on this gate in its frontmatter before any integration work starts; this step proves the gate can be marked done. The desktop client remains optional.

**Out of scope:** Building or launching the desktop client.

---

## Context

Desktop is intended to be an optional client, but current Task 208 can run after its original control gates. This new gate must prove the full isolated workflow without any desktop process.

**Affected files:** `docs/testing.md`, `e2e/`, `backlog/208-build-desktop-client-after-control-gates.md`.

## Goals

1. Must prove two concurrent isolated workers, peer/human messages, recovery, terminal shell, and Git finalization through CLI/TUI.
2. Must document supported host/provider combinations and record real smoke results.
3. Must keep desktop work blocked until this task is done while retaining its original prerequisites.

## Implementation

### Step 1 — `docs/testing.md`: add repeatable macOS and Linux host smoke instructions and expected event/terminal evidence.

### Step 2 — `e2e/`: add opt-in isolated two-worker lifecycle coverage and failure injection.

### Step 3 — `backlog/208-build-desktop-client-after-control-gates.md`: verify the pre-added Task 217 prerequisite remains in frontmatter and prose.

## Acceptance criteria

- [ ] With no desktop process, CLI/TUI completes two worker runs and a peer review with human reply.
- [ ] Daemon restart preserves healthy VM sessions; VM failure is surfaced and does not duplicate a claim.
- [ ] Finalized changes land through host Git operations; Task 208 remains blocked until this gate is done.
- [ ] No changes to files outside the stated scope.

## Tests

Run full `npm test`, opt-in macOS and Linux two-VM smoke, and `orc doctor`.

## Verification

`nvm use 24 && npm test`.

## Risk / Rollback

**Risk:** A partial smoke could falsely unblock the desktop.
**Rollback:** Keep Task 217 unfinished and Task 208 gated until the missing host evidence is recorded.
