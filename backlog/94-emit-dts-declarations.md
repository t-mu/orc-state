---
ref: publish/94-emit-dts-declarations
feature: publish
priority: high
status: done
---

# Task 94 — Emit .d.ts Declaration Files for Package Consumers

Independent.

## Scope

**In scope:**
- Add `tsconfig.build.json` that extends the base tsconfig with `emitDeclarationOnly`, `declaration`, and `outDir: "dist"`
- Add `"build:types"` script to `package.json`
- Update `exports` map with per-entry `types` conditions for all subpath exports
- Update top-level `types` field to point to `dist/index.d.ts`
- Add `dist/` to `.gitignore` and `"dist"` to `files` array

**Out of scope:**
- Compiling `.ts` to `.js` — runtime stays on Node 24 native type stripping
- Changing any import specifiers or runtime code
- Modifying `index.ts` exports or any library logic

---

## Context

The package currently ships raw `.ts` files with `"types": "./index.ts"`. This works for consumers who enable `allowImportingTsExtensions` in their tsconfig, but standard TypeScript toolchains expect `.d.ts` files. Emitting declarations broadens compatibility without adding a full build step.

### Current state
- `tsconfig.json`: `noEmit: true`, `allowImportingTsExtensions: true`
- `"types": "./index.ts"` — requires consumers to have `allowImportingTsExtensions`
- `exports` map has flat string values (no `types` conditions)
- No `dist/` directory, no build script
- Verified: `tsc --emitDeclarationOnly` works with `allowImportingTsExtensions` on TS 5.9

### Desired state
- `tsconfig.build.json` generates `.d.ts` into `dist/`
- `exports` map has per-entry `types` conditions so TypeScript resolves declarations correctly
- `"types"` field points to `dist/index.d.ts`
- `dist/` is gitignored but included in the published package

### Start here
- `tsconfig.json` — base config to extend
- `tsconfig.check.json` — existing extension pattern to follow
- `package.json` — `exports`, `types`, `scripts`, `files` fields

**Affected files:**
- `tsconfig.build.json` — new file
- `package.json` — `exports`, `types`, `scripts`, `files`
- `.gitignore` — add `dist/`

---

## Goals

1. Must: `npm run build:types` exits 0 and produces `.d.ts` files in `dist/`.
2. Must: Every subpath in `exports` has a `types` condition pointing to the corresponding `.d.ts`.
3. Must: `"types"` field points to `"./dist/index.d.ts"`.
4. Must: `dist/` appears in `.gitignore`.
5. Must: `dist/` is included via the `files` array so it ships in the tarball.
6. Must: No runtime code changes — only type metadata and build config.

---

## Implementation

### Step 1 — Create tsconfig.build.json

**File:** `tsconfig.build.json` (new)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "emitDeclarationOnly": true,
    "declaration": true,
    "outDir": "dist"
  },
  "exclude": [
    "node_modules",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.e2e.test.ts",
    "test-fixtures/**",
    "dist"
  ]
}
```

### Step 2 — Add build:types script

**File:** `package.json`

Add to `scripts`:
```json
"build:types": "tsc --project tsconfig.build.json"
```

### Step 3 — Update exports with types conditions

**File:** `package.json`

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./index.ts" },
  "./adapters": { "types": "./dist/adapters/index.d.ts", "default": "./adapters/index.ts" },
  "./coordinator": { "types": "./dist/coordinator.d.ts", "default": "./coordinator.ts" },
  "./lib/stateValidation": { "types": "./dist/lib/stateValidation.d.ts", "default": "./lib/stateValidation.ts" },
  "./lib/eventValidation": { "types": "./dist/lib/eventValidation.d.ts", "default": "./lib/eventValidation.ts" },
  "./schemas/*": "./schemas/*.json"
}
```

### Step 4 — Update types field

**File:** `package.json`

```json
"types": "./dist/index.d.ts"
```

### Step 5 — Add dist to gitignore and files

**File:** `.gitignore` — add `dist/`
**File:** `package.json` `files` — add `"dist"`

---

## Acceptance criteria

- [ ] `tsconfig.build.json` exists and extends `tsconfig.json`.
- [ ] `npm run build:types` exits 0.
- [ ] `dist/index.d.ts` exists after build.
- [ ] `dist/adapters/index.d.ts`, `dist/coordinator.d.ts`, `dist/lib/stateValidation.d.ts`, `dist/lib/eventValidation.d.ts` exist after build.
- [ ] Every `exports` entry (except `schemas/*`) has a `types` condition.
- [ ] `"types"` is `"./dist/index.d.ts"`.
- [ ] `dist/` is in `.gitignore`.
- [ ] `npm pack --dry-run` includes `dist/` files.
- [ ] No runtime code changes.
- [ ] `npm test` passes.

---

## Tests

No new unit tests. Validation is via build output inspection and `npm pack --dry-run`.

---

## Verification

```bash
# Build declarations
npm run build:types

# Verify output exists
ls dist/index.d.ts dist/adapters/index.d.ts dist/coordinator.d.ts dist/lib/stateValidation.d.ts dist/lib/eventValidation.d.ts

# Verify pack includes dist
npm pack --dry-run 2>&1 | grep 'dist/'

# Full suite
npm test
```

---

## Risk / Rollback

**Risk:** Declaration output structure must mirror source layout exactly for the `types` conditions in `exports` to resolve. Verify paths after first build.
**Rollback:** `rm -rf dist tsconfig.build.json && git restore package.json .gitignore`
