---
ref: vnext-control-plane/206-package-one-project-container
feature: vnext-control-plane
review_level: full
priority: normal
status: todo
depends_on:
  - vnext-control-plane/195-prove-provider-and-terminal-protocols
  - vnext-control-plane/201-add-local-daemon-control-api
  - vnext-control-plane/204-launch-workers-in-assigned-worktrees
---

# Task 206 — Package one persistent project container

Depends on Tasks 195, 201 and 204.

## Scope

**In scope:** Project-scoped image/launcher, persistence volumes, localhost control transport, hardening and preflight.

**Out of scope:** Per-agent containers and optional private-clone workspace mode.

---

## Context

### Current state

`docker/dev` is a development shell; its compose file mounts host GitHub config and does not start a long-lived project daemon.

### Desired state

One non-root project container runs coordinator/master/workers as separate processes, with persistent scoped login and runtime state.

### Start here

- `docker/dev/Dockerfile` — installed tools.
- `docker/dev/docker-compose.yml` — current mounts.

**Affected files:** new project runtime packaging, preflight, documentation and integration tests.

---

## Goals

1. Must mount only project and scoped volumes; no host home, Docker socket or privileged container.
2. Must restrict control access to authenticated host loopback or equivalent Docker transport.
3. Must document that read/write project bind mounts expose that project to agents.

## Implementation

1. Adapt dev image into a reproducible project runtime without changing devbox behavior.
2. Add launcher and preflight for UID/GID, Git worktrees, provider login and required tooling.
3. Test persistence across container recreation and two parallel workers.

## Acceptance criteria

- [ ] Host home and Docker socket are inaccessible; project mount is writable and risk documented.
- [ ] Login state, SQLite and workspaces persist across recreation.
- [ ] Two workers run in one container and host control cannot bind to LAN.

## Tests

Opt-in Docker integration tests for mounts, ownership, persistence and network binding.

## Verification

`npm test`; `orc doctor`; documented Docker smoke.

## Risk / Rollback

**Risk:** Mount/UID mismatch prevents work or exposes extra host paths. **Rollback:** Stop new launcher and use existing host CLI/devbox; retain project and runtime volumes for recovery.
