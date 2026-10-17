---
ref: vnext-control-plane/195-prove-provider-and-terminal-protocols
feature: vnext-control-plane
review_level: none
priority: high
status: blocked
---

# Task 195 — Prove subscription provider and terminal protocols

Independent. This is a technology spike, not an orchestration integration.

## Scope

**In scope:** Opt-in Codex and Claude subscription smoke runs, local structured protocol capture, tmux cross-process attach, and host-to-container transport experiment.

**Out of scope:** Paid inference APIs, adapter replacement, desktop UI, and credentials in committed artifacts.

---

## Context

### Current state

The PTY adapter drives installed CLIs; `docker/dev` has tmux but no attach broker. Provider structured and subscription behavior is unverified for this installation.

### Desired state

Sanitized, reproducible evidence identifies which structured protocol paths are safe to adopt and how terminal/control transport works on the actual host.

### Start here

- `adapters/pty.ts` — existing provider launch.
- `docker/dev/` — development image and compose file.

**Affected files:** `docs/vnext-provider-protocols.md`, optional opt-in smoke scripts under `scripts/`.

---

## Goals

1. Must record exact versions, login prerequisites, billing/auth mode, protocol frames, approvals, resume and failure behavior for Codex and Claude.
2. Must ensure no inherited API key selects metered billing.
3. Must prove or falsify tmux attach from a separate process and a container-local transport accessible only from the host loopback.

## Implementation

1. Run one minimal Codex app-server and one Claude structured local session with existing subscriptions; record sanitized protocol traces and whether session resume works.
2. Test second-process tmux attach/detach and daemon-process exit while tmux remains alive.
3. Test Unix socket or authenticated loopback transport through Docker on the actual OS. Document chosen path and rejected alternatives.

## Acceptance criteria

- [ ] Evidence identifies a demonstrably subscription-backed path or explicitly records fallback to CLI for each provider.
- [ ] No committed token, API key, or private transcript.
- [ ] Terminal and container transport results include exact commands, versions, and failure cases.

## Tests

Opt-in real-provider smoke only; no CI dependency on login or paid API keys.

## Verification

`npm test`; manually rerun documented smoke commands where credentials are available.

## Current blockers (2026-10-17)

The sanitized local results and rerun commands are in
`docs/vnext-provider-protocols.md`. The Claude structured turn returned
`is_error: true` and exit code 1 despite a Team login status, so a successful
subscription turn and resume are unproven. Docker CLI/host daemon access is
unavailable in the dev container, so the required actual-host transport test
has not run. Keep this task blocked until both results are recorded.
