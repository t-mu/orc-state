# Tasks Created from Plan

I've created 4 backlog task specs from the TypeScript migration plan. Here's a summary:

---

## Task 1 — Migrate auth module to TypeScript
**Ref:** `ts-migration/migrate-auth-module`
**File:** `task-1.md`

Renames `auth.js` → `auth.ts`, adds `User`, `Session`, and `Token` type exports, enables strict mode. No logic changes. This task is independent and must land first because downstream tasks import its types.

---

## Task 2 — Migrate user service to TypeScript
**Ref:** `ts-migration/migrate-user-service`
**File:** `task-2.md`

Renames `userService.js` → `userService.ts`, imports `User` from `auth.ts`, and fixes any type errors TypeScript surfaces (treated as real bugs, not noise). Depends on Task 1.

---

## Task 3 — Migrate API routes to TypeScript
**Ref:** `ts-migration/migrate-api-routes`
**File:** `task-3.md`

Renames `routes/api.js` → `routes/api.ts`, imports types from `auth.ts` and `userService.ts`, adds explicit return types to all route handlers. Depends on Task 2.

---

## Task 4 — Update tsconfig and package.json
**Ref:** `ts-migration/update-tsconfig-and-scripts`
**File:** `task-4.md`

Adds `auth.ts`, `userService.ts`, and `routes/api.ts` to tsconfig `include`. Adds a `typecheck` npm script. Fixes any stale `.js` import paths in the migrated files. Depends on Task 3.

---

## Dependency chain

```
Task 1 → Task 2 → Task 3 → Task 4
```

Each task is blocked on the previous one completing, because the type exports from earlier tasks are required by later tasks. The tasks can be worked sequentially by a single agent or dispatched one at a time in order.
