---
ref: craftsmanship-foundations/73-extract-claim-reset-helpers
feature: craftsmanship-foundations
priority: normal
status: todo
---

# Task 73 — Extract Claim Reset and Timestamp Validation Helpers in claimManager

Independent.

## Scope

**In scope:**
- Extract `resetClaimVolatileFields()` helper for repeated input/session state resets
- Extract `assertValidTimestamp()` helper for repeated timestamp validation
- Both are internal to `lib/claimManager.ts`

**Out of scope:**
- Splitting claimManager into sub-modules (separate task)
- Changing any validation or reset logic

---

## Context

### Current state

The pattern `claim.input_state = null; claim.input_requested_at = null; claim.session_start_retry_count = 0; ...` is repeated in `startRun`, `finishRun`, and `_expireLeasesCore`. The timestamp validation `if (!Number.isFinite(new Date(at).getTime()))` appears 4 times.

### Desired state

Internal helpers `resetClaimVolatileFields(claim)` and `assertValidTimestamp(ts, label)` called from all repetition sites.

### Start here

- `lib/claimManager.ts` — lines 127-131, 269-276, 493-495 (reset), lines 122, 167, 217, 263 (validation)

**Affected files:**
- `lib/claimManager.ts` — add helpers, replace inline code

---

## Goals

1. Must add `resetClaimVolatileFields(claim)` private helper
2. Must add `assertValidTimestamp(ts, label)` private helper
3. Must replace all inline occurrences with helper calls
4. Must not change any behavior

---

## Acceptance criteria

- [ ] No duplicated claim reset boilerplate in claimManager.ts
- [ ] No duplicated timestamp validation in claimManager.ts
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run lib/claimManager.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
