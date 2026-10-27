---
ref: isolagent-worker-runtime/211-add-a-headless-reconnectable-isolagent-supervisor-interface
feature: isolagent-worker-runtime
review_level: full
priority: high
status: cancelled
depends_on:
  - isolagent-worker-runtime/210-specify-and-prove-the-isolated-runtime-boundary
---

# Task 211 — Add a headless reconnectable isolagent supervisor interface

**Cancelled:** Isolagent integration and the desktop client will be developed outside the public orc-state repository. This spec is retained as historical design context and must not be dispatched here.

Depends on Task 210.

## Scope

In the separate isolagent repository, implement a noninteractive control interface that starts a named per-worktree VM and a specified guest command, returns durable instance and session identifiers, streams output, sends input and terminal resize, reports liveness and ownership, reconnects from a second host process, and stops only the requested instance. Preserve existing interactive `run` and `exec` behavior. Add tests for missing image, failed guest command, supervisor exit, reconnect, and name collisions. Publish a versioned CLI/protocol contract and a real macOS or Linux VM smoke result before orc-state depends on it. Track this as an external-repository prerequisite rather than attempting to edit isolagent from an orc-state worker worktree.

This is an external-repository gate. Keep it blocked in the orc-state backlog until the upstream isolagent work is merged and its release or commit is recorded here.

---

## Context

Isolagent `run` currently requires a terminal on stdin and owns an interactive session. An orc-state coordinator must launch and reconnect without owning that terminal. This is an external repository gate; do not dispatch an orc-state worktree worker to implement isolagent Go code.

**Affected files:** Upstream `src/cmd/isolagent/`, Upstream `src/internal/proto/` and `src/internal/vm/`, Upstream tests and README.

## Goals

1. Must start a named VM and specified guest command without terminal stdin.
2. Must return stable instance and guest session identifiers and support output, input, resize, probe, reconnect, and stop.
3. Must preserve interactive `run` and `exec` behavior and reject ambiguous instance names.

## Implementation

### Step 1 — Upstream `src/cmd/isolagent/`: add a versioned noninteractive control command or local API, with documented request and response shapes.

### Step 2 — Upstream `src/internal/proto/` and `src/internal/vm/`: expose command session identity and reconnectable stream semantics.

### Step 3 — Upstream tests and README: cover failed image/command, supervisor exit, stale handle, name collision, and second-process reconnect; publish a tagged/commit-pinned contract.

## Acceptance criteria

- [ ] A second host process reconnects to a live VM and can inspect and control the same guest session.
- [ ] Stopping one VM leaves another VM and its worktree untouched.
- [ ] Interactive `run` and `exec` regressions pass; the pinned upstream build passes its Go tests and a real VM smoke.
- [ ] No changes to files outside the stated scope.

## Tests

Run upstream `make test` and its guest/VM smoke on a supported host; record the tested commit. Orc-state `npm test` remains required for backlog completion.

## Verification

`nvm use 24 && npm test`.

## Risk / Rollback

**Risk:** An unstable upstream control contract can make orc-state recovery ambiguous.
**Rollback:** Keep the orc-state integration disabled until the upstream release is pinned and verified.
