---
ref: dynamic-workers/174-worker-architecture-docs-and-contracts
feature: dynamic-workers
review_level: light
priority: normal
status: done
depends_on:
  - dynamic-workers/173-live-worker-views-and-operator-contracts
---

# Task 174 — Update Worker Architecture Docs and Contracts

Depends on Task 173.

## Scope

**In scope:**
- Update architecture, contract, recovery, and testing docs to remove the old managed-slot model.
- Update AGENTS guidance that still implies persistent `orc-N` worker slots or homogeneous worker pools.
- Document the task-scoped worker lifetime, dynamic provider resolution, deterministic two-word names, and computed capacity model.

**Out of scope:**
- Runtime implementation changes for dispatch, cleanup, or worker naming.
- TUI/status/CLI behavior changes beyond matching the already-landed runtime model.
- New provider features unrelated to the worker-architecture shift.

---

## Context

After the runtime and operator surfaces move to ephemeral task-scoped workers, the remaining risk is contradictory documentation. Managed-slot language in contracts, recovery guidance, or testing docs will mislead future implementation work and operator debugging even if the code is correct.

This task keeps documentation cleanup separate from the operator-surface work so the implementation unit stays narrow and reviewable. It should land after the runtime and CLI/TUI behavior are stable enough to document accurately.

**Start here:**
- `docs/architecture.md` — current worker-pool model description
- `docs/contracts.md` — runtime lifecycle and worker contract text
- `docs/recovery.md` and `docs/testing.md` — operator/testing guidance that may still refer to slots

**Affected files:**
- `docs/architecture.md` — explain task-scoped workers and dispatch-time provider resolution
- `docs/contracts.md` — describe worker lifecycle without persistent slots
- `docs/configuration.md` — explain capacity vs active live workers and default provider behavior
- `docs/recovery.md` — remove stale slot-based recovery assumptions
- `docs/testing.md` — update test-model guidance for ephemeral workers
- `AGENTS.md` — update any remaining workflow text that assumes persistent slot workers

---

## Goals

1. Must remove managed-slot terminology from current runtime and operator docs.
2. Must document `max_workers` as concurrency rather than as a count of persistent workers.
3. Must document per-task provider resolution from `required_provider` or default config.
4. Must document deterministic two-word worker IDs as unique among active workers only.
5. Must keep AGENTS workflow text consistent with the runtime behavior after Tasks 171–173.

---

## Implementation

### Step 1 — Update architecture and contract docs

**Files:** `docs/architecture.md`, `docs/contracts.md`, `docs/configuration.md`

Replace descriptions of persistent worker pools with the new model:
- coordinator spawns task-scoped workers on demand
- workers disappear after completion
- capacity is computed from concurrency minus live workers
- provider is chosen per task at dispatch time

### Step 2 — Update recovery and testing guidance

**Files:** `docs/recovery.md`, `docs/testing.md`

Remove recovery/testing language that depends on stable `orc-N` workers or idle slot inventory. Explain how to reason about live worker IDs and capacity instead.

### Step 3 — Align AGENTS guidance

**File:** `AGENTS.md`

Update only the worker-architecture text that still assumes managed slots or homogeneous worker pools. Preserve the existing phased workflow and task-run protocol unless it needs wording changes to match the new live-worker model.

---

## Acceptance criteria

- [ ] Current docs no longer describe persistent managed worker slots as the normal runtime model.
- [ ] Docs describe `max_workers` as concurrency and explain live-worker capacity.
- [ ] Docs describe dynamic provider selection for task-scoped workers.
- [ ] Docs describe deterministic two-word worker names without random suffixes.
- [ ] AGENTS guidance no longer implies persistent `orc-N` worker slots.
- [ ] No changes to files outside the stated scope.

---

## Tests

Not applicable — task output is a markdown/data file, not executable code.

---

## Verification

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** A partial or inconsistent docs pass can leave contradictory guidance across architecture, recovery, testing, and AGENTS documents even though the runtime behavior is correct.
**Rollback:** `git restore docs/architecture.md docs/contracts.md docs/configuration.md docs/recovery.md docs/testing.md AGENTS.md && npm test`
