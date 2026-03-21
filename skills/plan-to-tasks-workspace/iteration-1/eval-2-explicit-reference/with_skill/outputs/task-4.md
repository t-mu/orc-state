---
ref: general/29-update-tsconfig-and-package-json
feature: general
priority: normal
status: todo
depends_on:
  - general/26-migrate-auth-module-to-typescript
  - general/27-migrate-user-service-to-typescript
  - general/28-migrate-api-routes-to-typescript
---

# Task 29 — Update tsconfig and package.json

Depends on Tasks 26, 27, and 28.

## Scope

**In scope:**
- `tsconfig.json` — add `auth.ts`, `userService.ts`, `routes/api.ts` to `include`; ensure `strict: true` is set
- `package.json` — add a `typecheck` npm script; update any import paths that reference old `.js` extensions

**Out of scope:**
- `auth.ts`, `userService.ts`, `routes/api.ts` — must not be modified in this task
- Adding new dependencies
- Changing the runtime entry point or build output configuration beyond the typecheck script

---

## Context

Tasks 26–28 rename three files to `.ts` and add type annotations. Before these tasks, `tsconfig.json` either did not exist or did not include these files. This task wires up the full TypeScript configuration so that running `npm run typecheck` validates all three migrated modules in one pass.

Any import paths in the project that still reference `.js` extensions for the migrated files must be updated so the TypeScript compiler can resolve them.

**Affected files:**
- `tsconfig.json` — updated or created
- `package.json` — `typecheck` script added

## Risk / Rollback

**Risk:** A misconfigured `tsconfig.json` can break the entire type-checking pass or, if `allowJs` is set incorrectly, silently include stale `.js` files alongside the new `.ts` files.

**Rollback:** `git restore tsconfig.json package.json && npm test`

---

## Goals

1. Must add `auth.ts`, `userService.ts`, and `routes/api.ts` to `tsconfig.json` `include` (or confirm they are covered by a glob pattern).
2. Must ensure `strict: true` is set in `tsconfig.json`.
3. Must add a `typecheck` script to `package.json` that runs `tsc --noEmit`.
4. Must update any import paths referencing the old `.js` filenames for the migrated modules.
5. Must not change existing `scripts` beyond adding `typecheck`.

---

## Implementation

### Step 1 — Update `tsconfig.json`

**File:** `tsconfig.json`

Ensure the file contains:

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "moduleResolution": "node",
    "esModuleInterop": true
  },
  "include": [
    "auth.ts",
    "userService.ts",
    "routes/api.ts"
  ]
}
```

If the file already has an `include` array or a glob that covers these paths, verify it and leave it intact.

### Step 2 — Add `typecheck` script to `package.json`

**File:** `package.json`

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

Add this to the existing `scripts` block without removing other entries.

### Step 3 — Update import paths

**File:** any file in the project that imports from `auth.js`, `userService.js`, or `routes/api.js`

Search for stale `.js` extension references and update them:

```typescript
// Before
import { something } from './auth.js';

// After
import { something } from './auth';
```

---

## Acceptance criteria

- [ ] `tsconfig.json` includes `auth.ts`, `userService.ts`, and `routes/api.ts` (directly or via glob).
- [ ] `tsconfig.json` has `"strict": true`.
- [ ] `npm run typecheck` exits 0 with no type errors.
- [ ] `package.json` has a `typecheck` script.
- [ ] No import paths reference the old `.js` filenames for migrated modules.
- [ ] `npm test` still passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new tests required. The `npm run typecheck` script acts as the verification gate for this task.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
npm run typecheck
```
