---
ref: general/1-npm-package-publish-readiness
feature: general
priority: critical
status: todo
---

# Task 1 — Fix npm Package for Publish Readiness

Independent.

## Scope

**In scope:**
- Remove non-existent `.mjs` file references from `package.json` `files` array
- Add `types` field to `package.json` pointing to a valid entry
- Expand `exports` map to cover `./lib/stateValidation` and `./lib/eventValidation`
- Add or update `README.md` section documenting Node 24 requirement and `node-pty` native build dependency
- Validate `npm pack --dry-run` produces a clean, installable tarball

**Out of scope:**
- Generating compiled `.d.ts` or `.mjs` output (no build step is in scope)
- Changing any runtime logic in `lib/`, `cli/`, or `adapters/`
- Updating test configuration

---

## Context

`package.json` currently declares `"files": [..., "index.mjs", "coordinator.mjs"]` but neither file exists in the repo — the codebase uses `.ts` with `--experimental-strip-types`. Running `npm publish` will include these phantom entries in the manifest, potentially confusing package consumers and breaking installs that try to resolve them. Additionally, there is no `types` field, no exports for commonly needed internal modules, and no documentation on the hard Node 24 and native build requirements.

### Current state
- `package.json` `files` includes `index.mjs`, `coordinator.mjs` (neither exist)
- No `types` field
- `exports` covers only `.`, `./adapters`, `./coordinator`, `./schemas/*`
- No consumer-facing documentation on Node ≥ 24 or `node-pty` native build

### Desired state
- `npm pack --dry-run` lists only files that actually exist on disk
- `types` field resolves to a valid `.ts` entry for consumers using `allowImportingTsExtensions`
- `exports` includes `./lib/stateValidation` and `./lib/eventValidation`
- README documents the Node 24 requirement and `node-pty` native compilation step

### Start here
- `package.json` — `files`, `exports`, `types`, `engines` fields
- `README.md` — consumer setup section

**Affected files:**
- `package.json` — package manifest, files array, exports map, types field
- `README.md` — consumer-facing documentation

---

## Goals

1. Must: `npm pack --dry-run` lists zero files that do not exist on disk.
2. Must: `package.json` has a `types` field that resolves to an existing `.ts` file.
3. Must: `exports` map includes `./lib/stateValidation` and `./lib/eventValidation` pointing to their `.ts` paths.
4. Must: README contains a "Requirements" or "Setup" section stating Node ≥ 24 and `node-pty` native build dependency.
5. Must: No existing export entries are removed or broken.

---

## Implementation

### Step 1 — Remove phantom `.mjs` entries from `files`

**File:** `package.json`

```json
// Before
"files": ["adapters", "cli", "index.mjs", "lib", "mcp", "schemas", "coordinator.mjs", "types", "skills", "templates"]

// After
"files": ["adapters", "cli", "lib", "mcp", "schemas", "types", "skills", "templates"]
```

### Step 2 — Add `types` field

**File:** `package.json`

```json
"types": "./index.ts"
```

Create `index.ts` at repo root if it does not exist, exporting the public surface:

```ts
export * from './coordinator.ts';
export * from './lib/stateValidation.ts';
export * from './lib/eventValidation.ts';
```

### Step 3 — Expand `exports` map

**File:** `package.json`

```json
"exports": {
  ".": "./index.ts",
  "./adapters": "./adapters/index.ts",
  "./coordinator": "./coordinator.ts",
  "./lib/stateValidation": "./lib/stateValidation.ts",
  "./lib/eventValidation": "./lib/eventValidation.ts",
  "./schemas/*": "./schemas/*.json"
}
```

### Step 4 — Document requirements in README

**File:** `README.md`

Add a "Requirements" section near the top:

```md
## Requirements

- **Node.js ≥ 24** (uses `--experimental-strip-types`; no build step)
- **Native build tools** — `node-pty` compiles a native addon on install.
  On macOS: Xcode Command Line Tools (`xcode-select --install`).
  On Linux: `build-essential` + `python3`.
```

---

## Acceptance criteria

- [ ] `npm pack --dry-run` output contains no path ending in `.mjs`.
- [ ] `package.json` has a `types` field pointing to an existing file.
- [ ] `package.json` `exports` includes `./lib/stateValidation` and `./lib/eventValidation`.
- [ ] README contains a Requirements section mentioning Node ≥ 24 and `node-pty` native build.
- [ ] `npm pack --dry-run` exits 0 with no warnings about missing files.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new unit tests required. Validation is via `npm pack --dry-run` output inspection.

Add a manual smoke check to CI comments:

```bash
# Confirm no phantom .mjs in pack manifest
npm pack --dry-run 2>&1 | grep '\.mjs' && echo "FAIL: .mjs found" || echo "PASS"
```

---

## Verification

```bash
# Confirm pack output is clean
npm pack --dry-run

# Confirm exports resolve (Node 24)
node --experimental-strip-types -e "import('./lib/stateValidation.ts').then(() => console.log('ok'))"
node --experimental-strip-types -e "import('./lib/eventValidation.ts').then(() => console.log('ok'))"

# Full suite
nvm use 24 && npm test
```

## Risk / Rollback

**Risk:** Adding `index.ts` re-exports may expose internal types to consumers unexpectedly, or cause circular import if `index.ts` imports from files that transitively import it.
**Rollback:** `git restore package.json index.ts README.md && npm test`
