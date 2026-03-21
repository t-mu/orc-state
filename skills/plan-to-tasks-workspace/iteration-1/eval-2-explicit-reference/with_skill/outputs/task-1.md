---
ref: general/26-migrate-auth-module-to-typescript
feature: general
priority: normal
status: todo
---

# Task 26 — Migrate auth module to TypeScript

Independent.

## Scope

**In scope:**
- `auth.ts` — rename from `auth.js`, add `User`, `Session`, and `Token` type definitions, enable strict mode
- Types only: no logic changes permitted

**Out of scope:**
- `userService.js`, `routes/api.js` — migrated in later tasks
- `tsconfig.json`, `package.json` — updated in Task 29
- Any changes to runtime behaviour or business logic

---

## Context

The codebase currently uses plain JavaScript files with no type safety. Migrating to TypeScript enables type-checking across the module boundary. The auth module is the foundational source of shared types (`User`, `Session`, `Token`) that downstream modules (`userService`, `api`) will import — it must be migrated first.

This task is types-only: rename the file, add interfaces/type aliases, enable `strict: true` in the TypeScript compilation for this file. No logic changes are introduced.

**Affected files:**
- `auth.js` → `auth.ts` — migrated module, types added

---

## Goals

1. Must rename `auth.js` to `auth.ts`.
2. Must define exported `User`, `Session`, and `Token` types (interfaces or type aliases) in `auth.ts`.
3. Must enable TypeScript strict mode for this file (via tsconfig or inline `// @ts-check` equivalent — defer tsconfig entry to Task 29).
4. Must not change any runtime logic in `auth.ts`.
5. Must not break any existing tests that import from the auth module.

---

## Implementation

### Step 1 — Rename `auth.js` to `auth.ts`

**File:** `auth.ts` (was `auth.js`)

Rename the file. No content changes yet.

### Step 2 — Add type definitions

**File:** `auth.ts`

Add exported interfaces above the existing logic:

```typescript
export interface User {
  id: string;
  email: string;
  // extend with fields already used in the file
}

export interface Session {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

export interface Token {
  value: string;
  type: 'access' | 'refresh';
  expiresAt: Date;
}
```

Annotate existing function parameters and return types using these interfaces. Do not alter logic.

### Step 3 — Verify no logic changes

Review the diff against the original `auth.js` to confirm only type annotations and the rename are present.

---

## Acceptance criteria

- [ ] `auth.ts` exists; `auth.js` is deleted.
- [ ] `auth.ts` exports `User`, `Session`, and `Token` types.
- [ ] `tsc --noEmit` on `auth.ts` exits 0 with no type errors.
- [ ] No runtime logic changed — diff shows only type annotations added.
- [ ] All tests that previously imported from `auth.js` still pass.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** existing test suite (path TBD based on project layout)

No new tests required — this is a types-only change. The existing tests serve as the regression gate.

```
it('should export User type')  // type-level only; covered by tsc --noEmit
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
# Confirm auth.ts compiles cleanly
npx tsc --noEmit auth.ts
```
