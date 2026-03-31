---
ref: craftsmanship-foundations/69-consolidate-timing-constants
feature: craftsmanship-foundations
priority: normal
status: done
---

# Task 69 — Consolidate Magic Timing Constants into lib/constants.ts

Depends on Task 68.

## Scope

**In scope:**
- Move scattered timeout/interval constants into `lib/constants.ts`
- Update all import sites

**Out of scope:**
- Provider-specific timeout defaults in `lib/providers.ts` (these are configuration, not constants)
- Changing any timeout values

---

## Context

### Current state

Timing constants are scattered: `GIT_OP_TIMEOUT_MS` and `AGENT_DEAD_TTL_MS` are local to `coordinator.ts`, `DEFAULT_SCOUT_READY_TIMEOUT_MS` is local to `mcp/handlers.ts`, `HEARTBEAT_INTERVAL_MS` is hardcoded in `cli/run-input-request.ts`.

### Desired state

All timing constants with semantic names live in `lib/constants.ts`. Each original file imports rather than defines.

### Start here

- `lib/constants.ts` — add new timing constant exports
- `coordinator.ts` — lines 83, 86 local constants to move
- `mcp/handlers.ts` — line 28 local constant to move

**Affected files:**
- `lib/constants.ts` — add exports
- `coordinator.ts` — replace local definitions with imports
- `mcp/handlers.ts` — replace local definition with import
- `cli/run-input-request.ts` — replace hardcoded value with import

---

## Goals

1. Must move `GIT_OP_TIMEOUT_MS`, `AGENT_DEAD_TTL_MS`, `DEFAULT_SCOUT_READY_TIMEOUT_MS` to `lib/constants.ts`
2. Must replace all local definitions with imports
3. Must not change any timeout values

---

## Acceptance criteria

- [ ] No timing constants defined locally in coordinator.ts, mcp/handlers.ts, or cli/run-input-request.ts
- [ ] All imported from `lib/constants.ts`
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
