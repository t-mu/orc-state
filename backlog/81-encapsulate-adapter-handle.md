---
ref: craftsmanship-foundations/81-encapsulate-adapter-handle
feature: craftsmanship-foundations
priority: low
status: todo
---

# Task 81 — Encapsulate Adapter Session Handle Format

Independent.

## Scope

**In scope:**
- Add `createSessionHandle(agentId)` factory to adapter interface
- Replace inline `pty:${agentId}` construction outside of pty.ts

**Out of scope:**
- Changing the handle format itself
- Modifying the adapter interface significantly

---

## Context

### Current state

The `pty:{agentId}` session handle format is constructed inline in tests and potentially in other files. The `parseSessionHandle` function exists in `adapters/pty.ts` but the construction side is not encapsulated.

### Desired state

`createSessionHandle(agentId)` exported from the adapter, so the format is never constructed inline outside the adapter module.

### Start here

- `adapters/pty.ts` — line 120, `parseSessionHandle`
- `adapters/interface.ts` — adapter interface

**Affected files:**
- `adapters/pty.ts` — add `createSessionHandle` export
- `adapters/interface.ts` — add to interface if appropriate
- Test files — replace inline `pty:${id}` with factory call

---

## Goals

1. Must add `createSessionHandle(agentId)` to adapter
2. Must replace inline handle construction outside adapter
3. Must not change handle format

---

## Acceptance criteria

- [ ] `createSessionHandle` exported from adapter
- [ ] No inline `pty:${...}` construction outside adapter and its tests
- [ ] `npm test` passes

---

## Verification

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
