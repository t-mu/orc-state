---
ref: ts-migration/migrate-user-service
feature: ts-migration
priority: normal
status: todo
---

# Task 2 — Migrate user service to TypeScript

Depends on Task 1 (ts-migration/migrate-auth-module). Blocks Task 3.

## Scope

**In scope:**
- Rename `userService.js` to `userService.ts`
- Import the `User` type from `auth.ts`
- Fix any type errors that emerge — treat them as real bugs, not noise

**Out of scope:**
- Migrating `routes/api.js` (covered in Task 3)
- Updating tsconfig or package.json (covered in Task 4)
- Adding new features or refactoring logic beyond what type errors require

---

## Context

With the auth module now typed (Task 1), the user service can import and use those types. The user service is the next natural migration target because it is a direct consumer of `User` and feeds into the API routes layer.

### Current state

`userService.js` is plain JavaScript. It consumes auth objects but has no type annotations. Any misuse of `User` properties or incorrect return shapes is invisible to the compiler.

### Desired state

`userService.ts` imports `User` from `auth.ts` and applies it to function parameters and return types. All type errors uncovered during migration are fixed. The file compiles cleanly under strict mode.

### Start here

- `userService.js` — the file to be renamed and typed
- `auth.ts` — source of the `User` type (completed in Task 1)

### Dependency context

Task 1 renamed `auth.js` → `auth.ts` and exported `User`, `Session`, and `Token` types. This task relies on those exports being in place before the import can be written.

**Affected files:**
- `userService.js` → `userService.ts` — user service; receives type annotations and bug fixes surfaced by type checking

---

## Goals

1. Must rename `userService.js` to `userService.ts` without altering logic beyond what type errors require.
2. Must import `User` from `auth.ts` and use it to type all relevant parameters and return values.
3. Must fix every type error that TypeScript surfaces — do not suppress with `any` or `@ts-ignore`.
4. Must compile without TypeScript errors under strict mode.
5. Must not change behavior observable to callers.

---

## Implementation

### Step 1 — Rename the file

```bash
git mv userService.js userService.ts
```

### Step 2 — Add import for User type

**File:** `userService.ts`

```ts
import type { User } from './auth.ts';
```

### Step 3 — Apply types to function signatures

**File:** `userService.ts`

```ts
export function getUser(id: string): User { ... }
export function createUser(data: Omit<User, 'id'>): User { ... }
// ... annotate all exported functions
```

### Step 4 — Fix type errors

Run `npx tsc --noEmit` and resolve each error. Each fix is a real bug correction — document what was wrong inline with a brief comment if the fix is non-obvious.

<!-- Invariant: do not modify any function logic beyond what type errors require -->

---

## Acceptance criteria

- [ ] `userService.ts` exists; `userService.js` does not.
- [ ] `User` is imported from `auth.ts` (not redefined locally).
- [ ] `tsc --noEmit` exits 0 for `userService.ts`.
- [ ] All type errors are fixed — no `any` suppressions or `@ts-ignore` added.
- [ ] All existing tests that import from `userService` continue to pass.
- [ ] No changes to files outside `userService.ts`.

---

## Tests

No new tests required unless a bug fix changes observable behavior, in which case add a regression test covering the corrected behavior.

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

**Risk:** Type errors in `userService.ts` may reveal real bugs. Fixing them changes runtime behavior — confirm each fix is correct before committing.
**Rollback:** `git mv userService.ts userService.js` and revert changes.
