---
ref: orc-warroom/49-orc-warroom-toolchain-prep
feature: orc-warroom
priority: normal
status: todo
required_provider: codex
---

# Task 49 — Toolchain prep: TSX loader, JSX config, and ink dependency pins

Independent. Blocks Tasks 50, 51, 52.

## Scope

**In scope:**
- Add `tsx@4.19.3` to `dependencies` in `package.json`
- Add `ink@5.2.1`, `react@18.3.1`, `terminal-image@3.0.0`, `ink-spinner@5.0.0` to `dependencies`
- Add `@types/react@18.3.21` to `devDependencies`
- Update `tsconfig.json` and `tsconfig.check.json` to support JSX and `.tsx` files
- Update `tsconfig.test.json` to include `.test.tsx` coverage for test typechecking
- Update `eslint.config.mjs` to include `.tsx` files
- Update `lint-staged` config to include `.tsx` pattern
- Update `vitest.config.mjs` to include `.tsx` test files
- Update `cli/orc.ts` to use `--import tsx/esm` for the `watch` subcommand only
- Add or update focused tests for `cli/orc.ts` dispatch behavior

**Out of scope:**
- Do not create any `.tsx` component files yet (that is Task 51)
- Do not modify any existing `.ts` files beyond `cli/orc.ts` and config files
- Do not modify tests outside the focused `cli/orc.ts` dispatch coverage needed for this task

---

## Context

### Current state

Node 24 `--experimental-strip-types` strips TypeScript type annotations but cannot handle JSX syntax or `.tsx` file extensions. The project has no JSX support anywhere. `tsconfig.json` includes only `**/*.ts`. `cli/orc.ts` dispatches all subcommands uniformly with `--experimental-strip-types`.

### Desired state

The `watch` subcommand is dispatched with `node --import tsx/esm` instead of `--experimental-strip-types`. All other subcommands remain unchanged. The tsconfig, eslint, lint-staged, and vitest configs recognize `.tsx` files. ink and react are installed at compatible versions.

### Start here

- `cli/orc.ts` — dispatch logic to understand where to add the special case
- `tsconfig.json` — current `compilerOptions` and `include` patterns
- `vitest.config.mjs` — current `include` pattern
- `eslint.config.mjs` — current file patterns

**Affected files:**
- `package.json`
- `package-lock.json`
- `cli/orc.ts`
- `cli/orc.test.ts`
- `tsconfig.json`
- `tsconfig.check.json`
- `tsconfig.test.json`
- `eslint.config.mjs`
- `vitest.config.mjs`
- (lint-staged config — wherever it lives in the project)

---

## Goals

1. Must add tsx@4.19.3, ink@5.2.1, react@18.3.1, terminal-image@3.0.0, ink-spinner@5.0.0 at exact pinned versions.
2. Must add @types/react@18.3.21 as a devDependency.
3. Must NOT use react@19 — ink's react-reconciler@0.29.0 pins `react: ^18.2.0`.
4. Must update `cli/orc.ts` so only the `watch` subcommand is spawned with `--import tsx/esm`; all others remain on `--experimental-strip-types`.
5. Must add `"jsx": "react-jsx"` and `"jsxImportSource": "react"` to `tsconfig.json` compilerOptions.
6. Must add `"**/*.tsx"` to `tsconfig.json` `include`.
7. Must update `tsconfig.test.json` so `.test.tsx` files are included in test typechecking.
8. Must update `tsconfig.check.json` exclusions so `.test.tsx` / `.e2e.test.tsx` files do not leak into production typechecking.
9. Must update eslint, lint-staged, and vitest to recognize `.tsx` files.
10. Must add focused coverage proving `watch` dispatches via `--import tsx/esm` while other subcommands continue using `--experimental-strip-types`.
11. Must pass `npm test` — no existing tests broken.

---

## Implementation

### Step 1 — Add dependencies

**File:** `package.json`

Add to `"dependencies"`:
```json
"ink": "5.2.1",
"ink-spinner": "5.0.0",
"react": "18.3.1",
"terminal-image": "3.0.0",
"tsx": "4.19.3"
```

Add to `"devDependencies"`:
```json
"@types/react": "18.3.21"
```

Run `npm install`.

### Step 2 — Update `cli/orc.ts`

Find the `spawnSync` call that dispatches all subcommands. Add a special case for `watch`:

```typescript
const isTsx = sub === 'watch';
const nodeArgs = isTsx
  ? ['--import', 'tsx/esm', scriptPath, ...rest]
  : ['--experimental-strip-types', scriptPath, ...rest];

spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });
```

Invariant: all other subcommands must continue to use `--experimental-strip-types` unchanged.

### Step 3 — Update `tsconfig.json`

Add to `compilerOptions`:
```json
"jsx": "react-jsx",
"jsxImportSource": "react"
```

Update `include`:
```json
"include": ["**/*.ts", "**/*.tsx"]
```

### Step 4 — Update `tsconfig.check.json`

Do not duplicate JSX settings unless needed — they already inherit from `tsconfig.json`.
Instead, update exclusions so test TSX files stay out of production typechecking:

```json
"exclude": [
  "node_modules",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.e2e.test.ts",
  "**/*.e2e.test.tsx",
  "test-fixtures/**"
]
```

### Step 5 — Update `tsconfig.test.json`

Update include patterns so Vitest typecheck covers TSX tests:

```json
"include": ["**/*.test.ts", "**/*.test.tsx", "test-fixtures/**/*.ts", "test-fixtures/**/*.tsx"]
```

### Step 6 — Update `eslint.config.mjs`

Extend explicit test-file globs to include `.tsx` variants anywhere `.test.ts` patterns are used.

### Step 7 — Update `vitest.config.mjs`

```javascript
include: ['**/*.test.ts', '**/*.test.tsx']
```

### Step 8 — Update lint-staged config

Find the lint-staged pattern (likely in `package.json` or `.lintstagedrc`). Change `"*.{ts,mts,cts}"` to `"*.{ts,tsx,mts,cts}"`.

### Step 9 — Add focused `cli/orc.ts` dispatch coverage

Update `cli/orc.test.ts` to assert:
- `watch` dispatches with `['--import', 'tsx/esm', ...]`
- a non-watch command still dispatches with `['--experimental-strip-types', ...]`

Prefer mocking `spawnSync` or otherwise verifying the actual spawned node args. Do not use temporary `console.error(...)` probes for verification.

---

## Acceptance criteria

- [ ] `npm install` succeeds with all new packages at exact specified versions.
- [ ] `package-lock.json` is updated to match the exact dependency pins.
- [ ] Focused tests prove `orc watch` dispatches via `node --import tsx/esm`.
- [ ] Focused tests prove a non-watch command such as `orc status` still dispatches via `--experimental-strip-types`.
- [ ] `tsconfig.json` contains `"jsx": "react-jsx"` and `"jsxImportSource": "react"`.
- [ ] `tsconfig.test.json` includes `.test.tsx`, and `tsconfig.check.json` excludes `.test.tsx` / `.e2e.test.tsx`.
- [ ] `npm test` passes with zero failures.
- [ ] No changes to files outside the stated scope.

---

## Tests

Update `cli/orc.test.ts` with focused dispatcher coverage for `watch` vs non-watch node args. Confirm the existing test suite still passes.

---

## Verification

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** tsx version incompatibility with Node 24 or ESM resolution.
**Rollback:** revert `package.json`, `cli/orc.ts`, and the four config files. No state files touched.
