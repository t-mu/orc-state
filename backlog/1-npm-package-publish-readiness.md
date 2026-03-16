---
ref: general/1-npm-package-publish-readiness
feature: general
priority: critical
status: done
---

# Task 1 — Fix npm Package for Publish Readiness

Independent.

## Scope

**In scope:**
- Remove non-existent `.mjs` file references from `package.json` `files` array
- Add `"types"` directory and root files `index.ts` / `coordinator.ts` to `package.json` `files` array
- Add `types` field to `package.json` pointing to the existing `./index.ts`
- Expand `exports` map to cover `./lib/stateValidation` and `./lib/eventValidation`
- Update the existing `.npmignore` to also exclude `.test.ts` and `.integration.test.ts` files
- Add or update `README.md` section documenting Node 24 requirement and `node-pty` native build dependency
- Validate `npm pack --dry-run` produces a clean tarball with no test files and no phantom `.mjs` entries

**Out of scope:**
- Generating compiled `.d.ts` or `.mjs` output (no build step is in scope)
- Changing any runtime logic in `lib/`, `cli/`, or `adapters/`
- Modifying `index.ts` — it already exists with a deliberate public surface; do not overwrite it
- Updating test configuration

---

## Context

`package.json` currently declares `"files"` entries `"index.mjs"` and `"coordinator.mjs"` but neither file exists — the codebase uses `.ts` with `--experimental-strip-types`. These phantom entries are harmless (npm silently skips missing files) but signal incorrect metadata. More critically, the `files` array points at whole directories (`"cli"`, `"lib"`, `"mcp"`, `"adapters"`) without excluding test files, so `npm pack --dry-run` currently ships 159 files / 841 kB unpacked — including every `.test.ts` file. Consumers do not need tests.

`.npmignore` already exists at the repo root but only excludes `.test.mjs` patterns and vitest config — the `.test.ts` files are still being shipped. When both `files` and `.npmignore` are present, npm uses `files` as an inclusion allowlist and `.npmignore` as a further restriction within that set; updating `.npmignore` is therefore the correct mechanism for excluding test files from directory-level `files` entries.

Additionally: `index.ts` and `coordinator.ts` are referenced in `exports` but are not in the `files` array. npm behaviour on whether exports-referenced files are auto-included varies by version; add them explicitly to guarantee they land in the package.

### Current state
- `package.json` `files`: `["adapters","cli","index.mjs","lib","mcp","schemas","skills","templates","coordinator.mjs","contracts.md","README.md"]`
  - `index.mjs` and `coordinator.mjs` do not exist on disk
  - `"types"` directory and root files `index.ts`, `coordinator.ts` are absent from the list
- No `types` field in `package.json`
- `exports` map: `.`, `./adapters`, `./coordinator`, `./schemas/*` — missing `./lib/stateValidation` and `./lib/eventValidation`
- `index.ts` already exists at repo root with deliberate public surface (do not recreate)
- `.npmignore` exists and excludes `**/*.test.mjs`, `e2e/`, `vitest.config.mjs`, `vitest.e2e.config.mjs` — but not `.test.ts` or `.integration.test.ts`
- `npm pack --dry-run` outputs 159 files / 841 kB including all `.test.ts` and `.integration.test.ts` files

### Desired state
- `npm pack --dry-run` lists zero `.mjs` phantom entries and zero `.test.ts` / `.integration.test.ts` files
- `package.json` `files` includes `"types"`, `"index.ts"`, `"coordinator.ts"` and excludes `"index.mjs"` / `"coordinator.mjs"`
- `package.json` has a `types` field: `"./index.ts"` (for TypeScript consumers using `--experimental-strip-types` or `allowImportingTsExtensions`)
- `exports` includes `./lib/stateValidation` and `./lib/eventValidation`
- `.npmignore` updated to also exclude `**/*.test.ts` and `**/*.integration.test.ts`
- README documents Node ≥ 24 and `node-pty` native build requirement
- Packed file count and size are materially reduced

### Start here
- `package.json` — `files`, `exports`, `types` fields
- `.npmignore` — existing file to update (not replace)
- `index.ts` — existing public surface (read before touching; do not modify)

**Affected files:**
- `package.json` — files array, exports map, types field
- `.npmignore` — update existing file; preserve current content, add new patterns
- `README.md` — consumer-facing documentation

---

## Goals

1. Must: `npm pack --dry-run` output contains no path ending in `.mjs`.
2. Must: `npm pack --dry-run` output contains no path ending in `.test.ts` or `.integration.test.ts`.
3. Must: `package.json` has a `types` field set to `"./index.ts"`.
4. Must: `package.json` `files` includes `"types"`, `"index.ts"`, and `"coordinator.ts"`.
5. Must: `exports` map includes `./lib/stateValidation` and `./lib/eventValidation` pointing to their `.ts` paths.
6. Must: README contains a "Requirements" section stating Node ≥ 24 and `node-pty` native build dependency.
7. Must: No existing export entries are removed or broken. `index.ts` content is unchanged.

---

## Implementation

### Step 1 — Audit baseline

```bash
npm pack --dry-run 2>&1 | grep -E '\.mjs|\.test\.ts' | head -20
```

Confirm the current problems exist before making changes.

### Step 2 — Fix `files` array and add `types` field

**File:** `package.json`

```json
// Before
"files": ["adapters","cli","index.mjs","lib","mcp","schemas","skills","templates","coordinator.mjs","contracts.md","README.md"]

// After
"files": ["adapters","cli","coordinator.ts","index.ts","lib","mcp","schemas","types","skills","templates","contracts.md","README.md"]
```

Changes:
- Remove `"index.mjs"` and `"coordinator.mjs"` (do not exist)
- Add `"coordinator.ts"` and `"index.ts"` (root files referenced in `exports`)
- Add `"types"` (directory exists on disk; consumers need these type definitions)
- Keep `"contracts.md"` and `"README.md"` (intentional)

Also add the `types` field (alongside `"main"` or `"version"`):

```json
"types": "./index.ts"
```

Note: `"./index.ts"` as a `types` value is intentional for this source-distributed package — consumers run under Node 24 `--experimental-strip-types` or with `allowImportingTsExtensions`. There are no compiled `.d.ts` files.

### Step 3 — Update `.npmignore` to exclude test files

**File:** `.npmignore` (update existing — do NOT overwrite; append to existing content)

Existing content:
```
**/*.test.mjs
e2e/
vitest.config.mjs
vitest.e2e.config.mjs
```

Add these lines:
```
**/*.test.ts
**/*.integration.test.ts
```

When both `files` and `.npmignore` are present, npm uses `files` as the inclusion allowlist and `.npmignore` further restricts within that set. The `**/` prefix ensures the pattern matches test files at any depth inside the included directories.

### Step 4 — Expand `exports` map

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

### Step 5 — Document requirements in README

**File:** `README.md`

Add a "Requirements" section near the top (after the title/intro):

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
- [ ] `npm pack --dry-run` output contains no path ending in `.test.ts` or `.integration.test.ts`.
- [ ] `package.json` has a `types` field set to `"./index.ts"`.
- [ ] `package.json` `files` includes `"types"`, `"index.ts"`, and `"coordinator.ts"`.
- [ ] `package.json` `files` does not include `"index.mjs"` or `"coordinator.mjs"`.
- [ ] `package.json` `exports` includes `./lib/stateValidation` and `./lib/eventValidation`.
- [ ] `index.ts` at repo root is unchanged from its pre-task content.
- [ ] `.npmignore` retains its original patterns and additionally excludes `**/*.test.ts` and `**/*.integration.test.ts`.
- [ ] README contains a Requirements section mentioning Node ≥ 24 and `node-pty` native build.
- [ ] `npm pack --dry-run` exits 0 with no warnings about missing files.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new unit tests required. Validation is via `npm pack --dry-run` output inspection.

```bash
# Confirm no phantom .mjs in pack manifest
npm pack --dry-run 2>&1 | grep '\.mjs' && echo "FAIL: .mjs found" || echo "PASS"

# Confirm no test files in pack manifest
npm pack --dry-run 2>&1 | grep '\.test\.ts' && echo "FAIL: test files found" || echo "PASS"

# Confirm index.ts and coordinator.ts are in pack manifest
npm pack --dry-run 2>&1 | grep -E '^npm notice [0-9.]+(B|kB) (index|coordinator)\.ts' && echo "PASS: root ts files present" || echo "FAIL: root ts files missing"
```

---

## Verification

```bash
# Step 1: confirm baseline problems exist before changes
npm pack --dry-run 2>&1 | grep -E '\.mjs|\.test\.ts' | head -20

# Step 2: after changes, confirm clean pack
npm pack --dry-run 2>&1 | grep '\.mjs' && echo "FAIL" || echo "PASS: no .mjs"
npm pack --dry-run 2>&1 | grep '\.test\.ts' && echo "FAIL" || echo "PASS: no test files"

# Confirm exports map has the new entries
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(JSON.stringify(p.exports, null, 2))"

# Full suite
nvm use 24 && npm test
```

## Risk / Rollback

**Risk:** Adding `**/*.test.ts` to `.npmignore` alongside a `files` allowlist is correct npm behaviour, but verify the final pack still contains all expected runtime files (e.g. `lib/stateValidation.ts`, `cli/orc.ts`).

**Risk:** `index.ts` and `coordinator.ts` added explicitly to `files` — confirm they appear in `npm pack --dry-run` output before declaring success.

**Rollback:** `git restore package.json README.md .npmignore && npm test`
