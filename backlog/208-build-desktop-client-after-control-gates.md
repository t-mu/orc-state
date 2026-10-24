---
ref: vnext-control-plane/208-build-desktop-client-after-control-gates
feature: vnext-control-plane
review_level: full
priority: low
status: todo
depends_on:
  - vnext-control-plane/201-add-local-daemon-control-api
  - vnext-control-plane/202-supervise-and-reconcile-agent-sessions
  - vnext-control-plane/203-integrate-structured-provider-runtimes
  - vnext-control-plane/205-add-terminal-broker-and-worktree-shell
  - vnext-control-plane/206-package-one-project-container
  - vnext-control-plane/207-route-peer-review-and-human-messages
  - isolagent-worker-runtime/217-prove-the-cli-tui-isolation-gate-and-block-desktop-until-it-passes
  - global-project-state/228-prove-the-clean-repo-cli-and-tui-workflow
---

# Task 208 — Build desktop client after control gates

Depends on Tasks 201, 202, 203, 205, 206, 207, 217 and 228. Do not start before both the isolated CLI/TUI gate in Task 217 and the clean-repo project-state gate in Task 228 pass.

## Scope

**In scope:** Project selector, agent sidebar, run/task inspector, activity/logs, worktree shell and scoped operator actions.

**Out of scope:** Scheduling or direct SQLite/Docker access from renderer; provider TUI simulation for structured sessions.

---

## Context

### Current state

Ink TUI and CLI exist. There is no desktop app or stable daemon client contract.

### Desired state

An optional desktop client reconnects to the daemon, observes isolated VM runs and intervenes while CLI/TUI remain fully functional without the desktop.

### Start here

- `lib/tui/` — reusable status concepts.
- Control API from Task 201 — client contract.

**Affected files:** new desktop app, shared protocol types, tests.

---

## Goals

1. Must render snapshot plus cursor events without lost updates on reconnect.
2. Must keep privileged Docker/filesystem operations in main process or daemon.
3. Must preserve CLI/TUI workflow when app is closed.
4. Must use the proven isolagent worker and scoped message APIs; an isolated run cannot silently fall back to an unsandboxed host worker.

## Implementation

1. Build Electron main process client and restricted renderer with React.
2. Add inspector, activity/logs and independent shell using existing API/broker.
3. Add blocker/approval/interrupt controls and reconnect tests.

## Acceptance criteria

- [ ] Existing run is visible and controllable after GUI restart.
- [ ] Renderer has no raw Docker, filesystem or SQLite privilege.
- [ ] CLI remains usable throughout desktop disconnect.
- [ ] Task 217 has passed its two-worker isolated CLI/TUI smoke before desktop implementation begins.
- [ ] Task 228 has proved database-owned task state and project-aware CLI/TUI against a clean target repo before desktop implementation begins.

## Tests

Protocol-contract and UI reconnect tests with fake daemon; opt-in desktop smoke.

## Verification

`npm test`; desktop integration suite; end-to-end CLI/GUI parallel smoke.

## Risk / Rollback

**Risk:** GUI reconnect could show stale state. **Rollback:** Keep app optional and use CLI; cursor replay restores accurate state after repair.
