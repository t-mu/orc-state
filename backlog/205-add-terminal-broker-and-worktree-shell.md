---
ref: vnext-control-plane/205-add-terminal-broker-and-worktree-shell
feature: vnext-control-plane
review_level: full
priority: normal
status: done
depends_on:
  - vnext-control-plane/195-prove-provider-and-terminal-protocols
  - vnext-control-plane/201-add-local-daemon-control-api
  - vnext-control-plane/202-supervise-and-reconcile-agent-sessions
---

# Task 205 — Add terminal broker and independent worktree shell

Depends on Tasks 195, 201 and 202.

## Scope

**In scope:** Attach/detach, input, resize, output/scrollback, retained logs, read-only observation and exclusive input lease; separate worktree shell.

**Out of scope:** Treating terminal keystrokes as command ACKs or making structured sessions appear as TUIs.

---

## Context

### Current state

`orc attach` and `control-worker` only print log tails. `node-pty` handles are process-local; tmux exists only in the dev image.

### Desired state

A second process can observe a running provider terminal or open an independent shell without stopping the worker; write access is explicitly leased.

### Start here

- `cli/attach.ts` — current read-only tail.
- `adapters/pty.ts` — PTY ownership/logging.

**Affected files:** terminal broker, CLI attach/shell, lease store, tests.

---

## Goals

1. Must make observation read-only by default and deny simultaneous writers.
2. Must provide a shell whose cwd is the run worktree, independent of provider session.
3. Must retain output and clear ownership on detach, expiry or process exit.

## Implementation

1. Build broker on the proven tmux/supervisor path and persist terminal metadata.
2. Expose attach/shell CLI through control API; implement lease acquire/release.
3. Test second-process attach, two-writer contention, resize and restart.

## Acceptance criteria

- [ ] Attach, detach and reconnect do not terminate active work.
- [ ] Two writers cannot control one provider terminal concurrently.
- [ ] Shell remains usable for headless structured provider runs.

## Tests

Fake terminal/broker integration tests plus opt-in tmux smoke.

## Verification

`npm test`; manual attach/detach smoke.

## Risk / Rollback

**Risk:** Lease loss could allow competing input. **Rollback:** Force read-only mode and use CLI input requests while broker ownership is repaired.
