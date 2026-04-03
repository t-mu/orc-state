---
ref: general/121-execution-mode-docs
feature: general
priority: low
status: todo
depends_on:
  - general/117-execution-mode-config-types
  - general/118-execution-mode-adapter-flags
  - general/119-execution-mode-runtime-threading
  - general/120-execution-mode-master-and-doctor
---

# Task 121 — Document Execution Mode Configuration

Depends on Tasks 117-120 (all implementation tasks must be complete first).

## Scope

**In scope:**
- Update `docs/configuration.md` with execution mode documentation
- Update `AGENTS.md` with execution mode operational guidance

**Out of scope:**
- Any code changes
- Any config or type changes

---

## Context

### Current state

`docs/configuration.md` documents the existing config schema (master, worker_pool, coordinator, lease sections). There is no mention of execution modes, sandbox settings, or trust levels. `AGENTS.md` does not mention execution modes.

### Desired state

Documentation covers:
- The two execution mode presets and their meaning
- Config field locations (top-level default, per-role)
- Environment variable overrides
- Per-provider behavior differences
- Scout override behavior
- Linux sandbox dependency requirements
- How execution mode interacts with the existing permission/bypass flags

### Start here

- `docs/configuration.md` — existing config documentation
- `AGENTS.md` — agent operational guide

**Affected files:**
- `docs/configuration.md` — new execution mode section
- `AGENTS.md` — brief execution mode reference

---

## Goals

1. Must document `default_execution_mode` top-level config field.
2. Must document `execution_mode` per-role field in master and worker_pool sections.
3. Must document env vars `ORC_MASTER_EXECUTION_MODE` and `ORC_WORKER_EXECUTION_MODE`.
4. Must document the two presets (`full-access`, `sandbox`) and what they mean per provider.
5. Must document scout override behavior (always sandboxed + read-only).
6. Must document Linux prerequisites (bubblewrap + socat) for Claude sandbox mode.
7. Must document that `full-access` is the default and preserves backward compatibility.

---

## Implementation

### Step 1 — Add Execution Modes section to configuration.md

**File:** `docs/configuration.md`

Add a new section "Execution Modes" covering:

- Overview: two presets controlling agent trust/freedom level
- Config fields and loading priority
- Per-provider flag mapping table
- Scout override explanation
- Linux prerequisites
- Example configurations

### Step 2 — Update AGENTS.md

**File:** `AGENTS.md`

Add a brief note in the Orchestrator Conventions section about execution modes, directing readers to `docs/configuration.md` for full details.

---

## Acceptance criteria

- [ ] `docs/configuration.md` has an Execution Modes section.
- [ ] Both presets documented with per-provider behavior.
- [ ] Env vars documented.
- [ ] Scout override documented.
- [ ] Linux prerequisites documented.
- [ ] `AGENTS.md` references execution modes.
- [ ] No code changes.

---

## Tests

No code tests. Verify documentation reads correctly and covers all acceptance criteria.

---

## Verification

```bash
# No code changes — manual review only
cat docs/configuration.md | grep -c "execution_mode"
# Expected: multiple occurrences
```
