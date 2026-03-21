---
ref: ts-migration/migrate-auth-module
feature: ts-migration
priority: normal
status: todo
---

# Task 1 — Migrate auth module to TypeScript

Independent.

## Scope

**In scope:**
- Rename `auth.js` to `auth.ts`
- Add TypeScript type definitions for `User`, `Session`, and `Token`
- Enable strict mode in the file (or via tsconfig targeting this file)

**Out of scope:**
- Logic changes of any kind — this is a types-only migration
- Migrating any other files (`userService.js`, `routes/api.js`, etc.)
- Updating tsconfig or package.json (covered in Task 4)

---

## Context

The project is being migrated from JavaScript to TypeScript to improve type safety and catch bugs at compile time. The auth module is the foundational dependency — its types (`User`, `Session`, `Token`) are consumed by the user service and API routes, so it must be migrated first.

### Current state

`auth.js` is a plain JavaScript file with no type annotations. Downstream modules have no compile-time guarantees about the shape of auth objects, making it easy to introduce type mismatches silently.

### Desired state

`auth.ts` exports named TypeScript interfaces or types for `User`, `Session`, and `Token`. All existing logic is preserved exactly. Strict mode is enabled. Downstream modules can import these types.

### Start here

- `auth.js` — the file to be renamed and typed

**Affected files:**
- `auth.js` → `auth.ts` — core auth module; receives type annotations, no logic changes

---

## Goals

1. Must rename `auth.js` to `auth.ts` without altering any runtime logic.
2. Must define and export a `User` type/interface covering all properties used in the codebase.
3. Must define and export a `Session` type/interface covering all properties used in the codebase.
4. Must define and export a `Token` type/interface covering all properties used in the codebase.
5. Must compile without TypeScript errors under strict mode.

---

## Implementation

### Step 1 — Rename the file

```bash
git mv auth.js auth.ts
```

### Step 2 — Add strict-mode header (if not handled by tsconfig)

**File:** `auth.ts`

```ts
// @ts-strict (or rely on tsconfig "strict": true)
```

### Step 3 — Define and export types

**File:** `auth.ts`

```ts
export interface User {
  id: string;
  // ... all existing properties
}

export interface Session {
  id: string;
  userId: string;
  // ... all existing properties
}

export interface Token {
  value: string;
  expiresAt: Date;
  // ... all existing properties
}
```

<!-- Invariant: do not modify any function bodies or runtime logic -->

---

## Acceptance criteria

- [ ] `auth.ts` exists; `auth.js` does not.
- [ ] `User`, `Session`, and `Token` are exported from `auth.ts`.
- [ ] `tsc --noEmit` (or equivalent typecheck script) exits 0 for `auth.ts`.
- [ ] All existing tests that import from `auth` continue to pass.
- [ ] No changes to files outside `auth.ts`.

---

## Tests

No new tests required — this is a types-only change. Existing tests must continue to pass without modification.

---

## Verification

```bash
# Typecheck the migrated file
npx tsc --noEmit
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** If the inferred types do not match actual runtime usage, TypeScript will surface errors. These should be fixed in this task, not deferred.
**Rollback:** `git mv auth.ts auth.js` and revert any type annotation additions.
