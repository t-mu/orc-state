---
ref: general/27-migrate-user-service-to-typescript
feature: general
priority: normal
status: todo
depends_on:
  - general/26-migrate-auth-module-to-typescript
---

# Task 27 — Migrate user service to TypeScript

Depends on Task 26. Blocks Task 28.

## Scope

**In scope:**
- `userService.ts` — rename from `userService.js`, import `User` type from `auth.ts`, fix type errors that surface

**Out of scope:**
- `auth.ts` — must not be modified; types are consumed, not defined, here
- `routes/api.js` — migrated in Task 28
- `tsconfig.json`, `package.json` — updated in Task 29
- Introducing new functionality or refactoring logic beyond fixing type errors

---

## Context

After Task 26, `auth.ts` exports the `User` type. `userService.js` constructs and handles `User` objects but has no type annotations. Renaming it to `.ts` and importing `User` from `auth.ts` will surface any existing type mismatches — these are real bugs, not noise from the migration, and must be fixed rather than suppressed with `any`.

**Affected files:**
- `userService.js` → `userService.ts` — migrated module

---

## Goals

1. Must rename `userService.js` to `userService.ts`.
2. Must import `User` from `auth.ts` and annotate all `User`-typed parameters and return values.
3. Must fix all type errors that emerge from the migration — do not use `any` to suppress them.
4. Must not change runtime logic except to fix type errors that indicate real bugs.
5. Must not break existing tests.

---

## Implementation

### Step 1 — Rename `userService.js` to `userService.ts`

**File:** `userService.ts` (was `userService.js`)

Rename the file. No content changes yet.

### Step 2 — Import `User` from `auth.ts`

**File:** `userService.ts`

Add at the top of the file:

```typescript
import type { User } from './auth';
```

### Step 3 — Annotate parameters and return types

**File:** `userService.ts`

For each function that accepts or returns a `User` object, add explicit type annotations:

```typescript
// Before
function getUser(id) { ... }

// After
function getUser(id: string): Promise<User> { ... }
```

### Step 4 — Fix type errors

**File:** `userService.ts`

Run `npx tsc --noEmit userService.ts` and fix each error. If an error reveals a logic mismatch (e.g. a field accessed on `User` that doesn't exist in the type), update the `User` type in `auth.ts` only if the field is genuinely part of the domain model — or fix the logic in `userService.ts`.

---

## Acceptance criteria

- [ ] `userService.ts` exists; `userService.js` is deleted.
- [ ] `import type { User } from './auth'` is present.
- [ ] `tsc --noEmit` on `userService.ts` exits 0 with no type errors.
- [ ] No `any` type suppressions introduced.
- [ ] All existing tests for `userService` pass.
- [ ] No changes to files outside the stated scope (except `auth.ts` if a missing field is discovered and legitimately added).

---

## Tests

**File:** existing userService test suite (path TBD)

No new tests required unless a type error reveals an untested code path. If a bug is found and fixed, add a regression test for that specific case.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
npx tsc --noEmit userService.ts
```
