---
ref: craftsmanship-foundations/77-dedup-state-init-logic
feature: craftsmanship-foundations
priority: normal
status: todo
---

# Task 77 — Extract State Init Logic into lib/stateInit.ts

Independent.

## Scope

**In scope:**
- Create `lib/stateInit.ts` with `ensureStateInitialized()` function
- Replace duplicated init code in `cli/init.ts` and `cli/start-session.ts`

**Out of scope:**
- Changing init behavior or adding new init capabilities

---

## Context

### Current state

State file creation (backlog.json, agents.json, claims.json, events DB) is implemented independently in `cli/init.ts` (lines 20-47) and `cli/start-session.ts` (lines 60-75).

### Desired state

Single `ensureStateInitialized(stateDir)` in `lib/stateInit.ts` called from both CLI files.

### Start here

- `cli/init.ts` — lines 20-47
- `cli/start-session.ts` — lines 60-75

**Affected files:**
- `lib/stateInit.ts` — new file
- `cli/init.ts` — replace inline init with import
- `cli/start-session.ts` — replace inline init with import

---

## Goals

1. Must create `lib/stateInit.ts` with `ensureStateInitialized()` export
2. Must replace both inline implementations
3. Must keep `cli/init.ts`'s `--force` backup logic as CLI-specific wrapper

---

## Acceptance criteria

- [ ] `lib/stateInit.ts` exists with `ensureStateInitialized` export
- [ ] Both CLI files use the shared function
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npm test
```
