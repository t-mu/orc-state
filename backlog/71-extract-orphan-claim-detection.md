---
ref: craftsmanship-foundations/71-extract-orphan-claim-detection
feature: craftsmanship-foundations
priority: normal
status: done
---

# Task 71 — Extract Orphaned Claim Detection into lib/claimDiagnostics.ts

Independent.

## Scope

**In scope:**
- Create `lib/claimDiagnostics.ts` with shared `getOrphanedClaims()` function
- Replace duplicated implementations in `cli/doctor.ts`, `cli/preflight.ts`, `cli/kill-all.ts`

**Out of scope:**
- Adding new diagnostic capabilities
- Changing orphan detection logic

---

## Context

### Current state

Orphaned claim detection (iterating claims, checking for `claimed`/`in_progress` state, verifying agent exists and is online) is implemented independently in `cli/doctor.ts` (lines 57-68), `cli/preflight.ts` (lines 108-123), and partially in `cli/kill-all.ts`.

### Desired state

Single `getOrphanedClaims(agents, claims)` function in `lib/claimDiagnostics.ts` used by all three CLI files.

### Start here

- `cli/preflight.ts` — lines 108-123, most complete implementation
- `cli/doctor.ts` — lines 57-68

**Affected files:**
- `lib/claimDiagnostics.ts` — new file
- `cli/doctor.ts` — replace inline logic with import
- `cli/preflight.ts` — replace inline logic with import
- `cli/kill-all.ts` — replace inline logic with import

---

## Goals

1. Must create `lib/claimDiagnostics.ts` with `getOrphanedClaims()` export
2. Must replace all inline implementations with the shared function
3. Must not change diagnostic behavior or output

---

## Acceptance criteria

- [ ] `lib/claimDiagnostics.ts` exists with `getOrphanedClaims` export
- [ ] All three CLI files import and use the shared function
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run cli/doctor.test.ts cli/preflight.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
