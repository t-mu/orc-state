---
ref: general/28-migrate-api-routes-to-typescript
feature: general
priority: normal
status: todo
depends_on:
  - general/26-migrate-auth-module-to-typescript
  - general/27-migrate-user-service-to-typescript
---

# Task 28 — Migrate API routes to TypeScript

Depends on Tasks 26 and 27. Blocks Task 29.

## Scope

**In scope:**
- `routes/api.ts` — rename from `routes/api.js`, import types from `auth.ts` and `userService.ts`, add return types to all route handlers

**Out of scope:**
- `auth.ts`, `userService.ts` — must not be modified in this task
- `tsconfig.json`, `package.json` — updated in Task 29
- Adding new routes or changing route logic

---

## Context

After Tasks 26 and 27, both `auth.ts` and `userService.ts` export typed interfaces. `routes/api.js` calls into both modules but has no type annotations on route handlers, meaning incorrect return shapes can go undetected. Migrating to `.ts` and adding return types to all handlers closes this gap.

Route handlers in Express (or equivalent) typically return `Response` objects or `void`. Adding explicit return types here will catch any handler that fails to return a response on some code path.

**Affected files:**
- `routes/api.js` → `routes/api.ts` — migrated module

---

## Goals

1. Must rename `routes/api.js` to `routes/api.ts`.
2. Must import types from `./auth` and `./userService` as needed.
3. Must add explicit return types to all route handler functions.
4. Must not change runtime logic.
5. Must not break existing route tests.

---

## Implementation

### Step 1 — Rename `routes/api.js` to `routes/api.ts`

**File:** `routes/api.ts` (was `routes/api.js`)

Rename the file.

### Step 2 — Add imports

**File:** `routes/api.ts`

```typescript
import type { User, Session, Token } from '../auth';
import type { /* relevant exports */ } from '../userService';
```

Import only the types actually referenced in the handlers.

### Step 3 — Add return types to all route handlers

**File:** `routes/api.ts`

For each route handler, add an explicit return type annotation:

```typescript
// Before
router.get('/user/:id', async (req, res) => {
  ...
});

// After
router.get('/user/:id', async (req: Request, res: Response): Promise<void> => {
  ...
});
```

Fix any type errors that emerge — these indicate real logic issues.

---

## Acceptance criteria

- [ ] `routes/api.ts` exists; `routes/api.js` is deleted.
- [ ] All imports from `auth` and `userService` use the `.ts` module paths.
- [ ] All route handlers have explicit return type annotations.
- [ ] `tsc --noEmit` on `routes/api.ts` exits 0 with no type errors.
- [ ] All existing route tests pass.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** existing route test suite (path TBD)

No new tests required for the migration itself. If a missing return on a code path is found and fixed, add a test for that path.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
npx tsc --noEmit routes/api.ts
```
