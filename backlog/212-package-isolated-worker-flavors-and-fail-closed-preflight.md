---
ref: isolagent-worker-runtime/212-package-isolated-worker-flavors-and-fail-closed-preflight
feature: isolagent-worker-runtime
review_level: full
priority: normal
status: todo
depends_on:
  - isolagent-worker-runtime/210-specify-and-prove-the-isolated-runtime-boundary
  - isolagent-worker-runtime/211-add-a-headless-reconnectable-isolagent-supervisor-interface
---

# Task 212 — Package isolated worker flavors and fail-closed preflight

Depends on Tasks 210, and 211.

## Scope

Provide a reproducible flavor image with Node 24, Git, the `orc` CLI, and a verified Claude CLI login path. Add explicit provider-to-flavor mapping and host capability checks in `lib/providers.ts` and preflight. Validate Codex and Gemini flavors separately before enabling them; the requested isolated provider must be rejected with a clear reason if its image, credentials, platform support, or egress rules are unavailable. Do not silently launch that worker on the host. Test Git worktree command execution and the host-controlled approval path for changed `.isolagent.toml` settings.

**Out of scope:** Desktop UI and provider implementations that lack a verified VM flavor.

---

## Context

Isolagent ships Claude and opencode examples, while orc-state supports Claude, Codex, and Gemini. Each enabled isolated provider needs a reproducible image and proven authentication, tooling, and egress behavior.

**Affected files:** `lib/providers.ts`, `cli/preflight.ts` and `cli/doctor.ts`, New flavor/build documentation under `docker/` or `examples/`.

## Goals

1. Must ship a documented Claude worker flavor with Node 24, Git, and orc CLI access.
2. Must map each enabled provider to a pinned flavor and reject missing or unsupported combinations before claim.
3. Must keep project setting approval on the host and validate required egress and Git operations.

## Implementation

### Step 1 — `lib/providers.ts`: add isolated runtime flavor resolution and explicit unavailable results.

### Step 2 — `cli/preflight.ts` and `cli/doctor.ts`: check isolagent binary, image, virtualization, provider login, and configured tunnel.

### Step 3 — New flavor/build documentation under `docker/` or `examples/`: pin image inputs and include Claude first; add Codex/Gemini only after their own real smoke.

## Acceptance criteria

- [ ] A valid Claude flavor executes worker bootstrap, Git commit/rebase, and `npm test` inside a VM.
- [ ] Missing image, login, tunnel, or platform support prevents claim with a specific error.
- [ ] Codex or Gemini cannot be selected in isolated mode until their own flavor smoke passes.
- [ ] No changes to files outside the stated scope.

## Tests

Unit tests for provider/flavor and preflight failures; opt-in real VM flavor smoke. Run `npm test` and `orc doctor`.

## Verification

`nvm use 24 && npm test`; `orc doctor`.

## Risk / Rollback

**Risk:** Image drift or broad egress could break or weaken isolation.
**Rollback:** Disable the isolated flavor mapping while retaining existing host transports.
