---
ref: ts-migration/update-tsconfig-and-scripts
feature: ts-migration
priority: normal
status: todo
---

# Task 4 — Update tsconfig and package.json

Depends on Task 3 (ts-migration/migrate-api-routes).

## Scope

**In scope:**
- Add `auth.ts`, `userService.ts`, and `routes/api.ts` to tsconfig `include` (or verify they are already covered)
- Add a `typecheck` script to `package.json`
- Update any import paths that reference the old `.js` extensions

**Out of scope:**
- Migrating any additional files beyond what Tasks 1–3 covered
- Changing compiler options beyond what is needed to support the migrated files
- Adding new npm dependencies

---

## Context

Tasks 1–3 renamed and typed the three core modules. This task wires up the TypeScript tooling so that `tsc` covers all migrated files in a single command and the typecheck is part of the standard development workflow.

### Current state

`tsconfig.json` may not include `auth.ts`, `userService.ts`, or `routes/api.ts`. There is no `typecheck` npm script. Some import statements may still reference `.js` file extensions that no longer exist.

### Desired state

`tsconfig.json` includes all three migrated files. `package.json` has a `typecheck` script that runs `tsc --noEmit`. All import paths resolve correctly. Running `npm run typecheck` exits 0.

### Start here

- `tsconfig.json` — compiler configuration to update
- `package.json` — scripts section to update
- `auth.ts`, `userService.ts`, `routes/api.ts` — verify imports use correct paths

**Affected files:**
- `tsconfig.json` — add migrated files to `include`
- `package.json` — add `typecheck` script
- `auth.ts`, `userService.ts`, `routes/api.ts` — fix any stale `.js` import paths

---

## Goals

1. Must ensure `tsconfig.json` includes `auth.ts`, `userService.ts`, and `routes/api.ts`.
2. Must add a `typecheck` script to `package.json` that runs `tsc --noEmit`.
3. Must update all import paths that reference `.js` files that have been renamed to `.ts`.
4. Must have `npm run typecheck` exit 0 with no errors.
5. Must not change tsconfig compiler options beyond what is required.

---

## Implementation

### Step 1 — Update tsconfig includes

**File:** `tsconfig.json`

```json
{
  "include": [
    "auth.ts",
    "userService.ts",
    "routes/api.ts"
    // ... any existing includes
  ]
}
```

If the existing tsconfig uses a glob that already covers these files (e.g., `"**/*.ts"`), no change is needed — just verify it.

### Step 2 — Add typecheck script

**File:** `package.json`

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

### Step 3 — Fix stale import paths

Search all three migrated files for imports that still use `.js` extensions:

```bash
grep -r "from '.*\.js'" auth.ts userService.ts routes/api.ts
```

Update each match to use the `.ts` extension or drop the extension if the resolver handles it.

<!-- Invariant: do not change tsconfig compiler options (strict, target, module, etc.) -->

---

## Acceptance criteria

- [ ] `tsconfig.json` covers `auth.ts`, `userService.ts`, and `routes/api.ts` (explicit or via glob).
- [ ] `package.json` has a `typecheck` script.
- [ ] `npm run typecheck` exits 0.
- [ ] No import paths in the migrated files point to `.js` files that have been renamed to `.ts`.
- [ ] All existing tests continue to pass.
- [ ] No changes to files outside `tsconfig.json`, `package.json`, and the three migrated `.ts` files.

---

## Tests

No new tests required. Run the full suite to confirm nothing regressed.

---

## Verification

```bash
# Confirm typecheck script works end-to-end
npm run typecheck
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Changing `tsconfig.json` includes may expose previously hidden type errors in other files if a glob is broadened. Narrow the include list to only the migrated files if needed.
**Rollback:** Revert `tsconfig.json` and `package.json` changes via `git checkout -- tsconfig.json package.json`.
