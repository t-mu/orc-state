---
ref: ts-migration/migrate-api-routes
feature: ts-migration
priority: normal
status: todo
---

# Task 3 — Migrate API routes to TypeScript

Depends on Task 2 (ts-migration/migrate-user-service). Blocks Task 4.

## Scope

**In scope:**
- Rename `routes/api.js` to `routes/api.ts`
- Import types from `auth.ts` and `userService.ts`
- Add explicit return types to all route handlers

**Out of scope:**
- Updating tsconfig or package.json (covered in Task 4)
- Changing route logic or adding new routes
- Migrating any other files

---

## Context

With the auth module and user service typed (Tasks 1 and 2), the API routes layer can now be migrated. Route handlers are the public surface of the application — typing their return values makes the contract explicit and catches any mismatch between what handlers return and what callers expect.

### Current state

`routes/api.js` is plain JavaScript. Route handlers return values without explicit types. Mismatches between handler return shapes and downstream consumers are not caught at compile time.

### Desired state

`routes/api.ts` imports types from `auth.ts` and `userService.ts`. Every route handler has an explicit return type annotation. The file compiles cleanly under strict mode.

### Start here

- `routes/api.js` — the file to be renamed and typed
- `auth.ts` — source of `User`, `Session`, `Token` types
- `userService.ts` — source of user service types/signatures

### Dependency context

Tasks 1 and 2 migrated `auth.js` → `auth.ts` and `userService.js` → `userService.ts`, exporting typed interfaces and functions. This task relies on those exports being in place before the imports can be written.

**Affected files:**
- `routes/api.js` → `routes/api.ts` — API route handlers; receives type annotations and explicit return types

---

## Goals

1. Must rename `routes/api.js` to `routes/api.ts` without altering any route logic.
2. Must import and use types from `auth.ts` and `userService.ts` where applicable.
3. Must add an explicit return type annotation to every route handler.
4. Must compile without TypeScript errors under strict mode.
5. Must not change the HTTP behavior of any route.

---

## Implementation

### Step 1 — Rename the file

```bash
git mv routes/api.js routes/api.ts
```

### Step 2 — Add type imports

**File:** `routes/api.ts`

```ts
import type { User, Session, Token } from '../auth.ts';
import type { ... } from '../userService.ts';
```

### Step 3 — Annotate route handler return types

**File:** `routes/api.ts`

```ts
// Example pattern — apply to all handlers
app.get('/users/:id', async (req, res): Promise<void> => {
  const user: User = await getUser(req.params.id);
  res.json(user);
});
```

### Step 4 — Fix any remaining type errors

Run `npx tsc --noEmit` and resolve each error. Do not suppress with `any` or `@ts-ignore`.

<!-- Invariant: do not change route paths, middleware order, or response shapes -->

---

## Acceptance criteria

- [ ] `routes/api.ts` exists; `routes/api.js` does not.
- [ ] Types from `auth.ts` and `userService.ts` are imported (not redefined locally).
- [ ] Every route handler has an explicit return type.
- [ ] `tsc --noEmit` exits 0 for `routes/api.ts`.
- [ ] No `any` suppressions or `@ts-ignore` added.
- [ ] All existing route tests continue to pass.
- [ ] No changes to files outside `routes/api.ts`.

---

## Tests

No new tests required — this is a types-only migration (plus fixing any real type errors uncovered). Existing tests must pass without modification.

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

**Risk:** Return type annotations may surface handler/response shape mismatches that require logic corrections. Verify each fix is intentional.
**Rollback:** `git mv routes/api.ts routes/api.js` and revert changes.
