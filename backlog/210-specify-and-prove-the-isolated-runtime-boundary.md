---
ref: isolagent-worker-runtime/210-specify-and-prove-the-isolated-runtime-boundary
feature: isolagent-worker-runtime
review_level: full
priority: normal
status: todo
---

# Task 210 — Specify and prove the isolated runtime boundary

Independent.

## Scope

Document the exact host/guest ownership and filesystem contract in `docs/vnext-architecture.md`. Add a reproducible opt-in proof that boots two isolagent VMs against distinct Git worktrees, tests commit and rebase with the required Git mount, reaches one host loopback port through a configured tunnel, and records macOS and Linux/KVM prerequisites. Verify that a VM cannot read the orchestration state directory or host credentials. Keep Task 206's in-progress container implementation separate and explain that a macOS Linux container cannot directly host Apple Virtualization.framework guests. This step produces the tested mount and transport contract consumed by later tasks.

---

## Context

The current vNext design assumes a project container, while isolagent boots a host-owned VM for a directory. Orc-state's worker worktrees and sibling layout need an explicit mount and control contract before implementation.

**Affected files:** `docs/vnext-architecture.md`, `docs/configuration.md`, `docs/testing.md`.

## Goals

1. Must define host, daemon, VM, provider, and Git ownership for attached and sibling layouts.
2. Must verify two concurrent worktree mounts and Git commit/rebase in real VMs.
3. Must verify the guest-to-host tunnel and denial of orchestration state and host credentials.

## Implementation

### Step 1 — `docs/vnext-architecture.md`: add the runtime diagram, VM lifetime, and Task 206 coexistence decision.

### Step 2 — `docs/configuration.md`: record macOS and Linux/KVM prerequisites and allowed mount/port rules.

### Step 3 — `docs/testing.md`: add reproducible opt-in two-VM commands and evidence format; no CI requirement for hardware virtualization.

## Acceptance criteria

- [ ] Two VMs operate on separate worktrees without seeing each other's files or `.orc-state`.
- [ ] Commit and rebase work from both VMs; host Git finalization remains daemon-owned.
- [ ] The configured host port is reachable, while an unlisted port and host credentials are inaccessible.
- [ ] No changes to files outside the stated scope.

## Tests

Run the documented opt-in two-VM smoke on a supported host; validate docs links and run `npm test`.

## Verification

`nvm use 24 && npm test`.

## Risk / Rollback

**Risk:** An inaccurate mount contract can expose host Git or prevent commits.
**Rollback:** Keep the existing host runtime while correcting the documented contract.
