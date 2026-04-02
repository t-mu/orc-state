---
ref: publish/111-fix-package-json-for-publish
feature: publish
priority: high
status: todo
---

# Task 111 — Fix package.json Exports, Files, and Metadata for Publish

Independent.

## Scope

**In scope:**
- Fix `exports["./schemas/*"]` to point to `./dist/schemas/*.json` (currently points to `./schemas/*.json` which doesn't ship)
- Remove `"skills"` and `"agents"` from `files` array (already copied into `dist/` by build script — shipping both is duplication)
- Add `"docs"` to `files` array (README links to `./docs/` which must be present on npmjs.com)
- Add `repository`, `homepage`, `bugs`, and `keywords` fields

**Out of scope:**
- Changing any exports other than `./schemas/*`
- Modifying the build script
- Changing any runtime code

---

## Context

Two critic sub-agents reviewed the package for consumer readiness and found four issues in `package.json`:

1. `exports["./schemas/*"]` resolves to `./schemas/*.json` but the root `schemas/` directory is not in the `files` array — only `dist/schemas/` ships (copied by the build script). Consumers importing `orc-state/schemas/backlog.schema.json` get `ERR_MODULE_NOT_FOUND`.
2. `skills/` and `agents/` are listed in `files` AND copied into `dist/` by the build script. The `orc install` command resolves them via `import.meta.url` which lands in `dist/`. Shipping both wastes ~120KB.
3. `docs/` is not in `files`, so README documentation links are dead on npmjs.com.
4. Standard npm metadata fields (`repository`, `homepage`, `bugs`, `keywords`) are missing — the registry listing has no links or discoverability.

### Current state

```json
"exports": {
  "./schemas/*": "./schemas/*.json"
},
"files": [
  "dist",
  "skills",
  "agents",
  "README.md"
]
```

No `repository`, `homepage`, `bugs`, or `keywords` fields.

### Desired state

```json
"exports": {
  "./schemas/*": "./dist/schemas/*.json"
},
"files": [
  "dist",
  "docs",
  "README.md"
]
```

Plus `repository`, `homepage`, `bugs`, and `keywords` fields populated.

### Start here

- `package.json` — the only file to modify

**Affected files:**
- `package.json` — exports, files, metadata fields

---

## Goals

1. Must change `exports["./schemas/*"]` to `"./dist/schemas/*.json"`.
2. Must remove `"skills"` and `"agents"` from the `files` array.
3. Must add `"docs"` to the `files` array.
4. Must add `repository`, `homepage`, `bugs`, and `keywords` fields.
5. Must not break any existing exports or the build pipeline.

---

## Implementation

### Step 1 — Fix schemas export path

**File:** `package.json`

Change:
```json
"./schemas/*": "./schemas/*.json"
```
To:
```json
"./schemas/*": "./dist/schemas/*.json"
```

### Step 2 — Fix files array

**File:** `package.json`

Change:
```json
"files": [
  "dist",
  "skills",
  "agents",
  "README.md"
]
```
To:
```json
"files": [
  "dist",
  "docs",
  "README.md"
]
```

### Step 3 — Add metadata fields

**File:** `package.json`

Add after the `"license"` field (or adjacent to existing metadata):

```json
"repository": {
  "type": "git",
  "url": "https://github.com/t-mu/orc-state.git"
},
"homepage": "https://github.com/t-mu/orc-state",
"bugs": "https://github.com/t-mu/orc-state/issues",
"keywords": [
  "orchestration",
  "multi-agent",
  "coding-agent",
  "autonomous",
  "provider-agnostic",
  "cli"
]
```

Note: the GitHub URL `t-mu/orc-state` is inferred from the git remote. If the remote URL differs, the worker should read it from `git remote get-url origin`.

---

## Acceptance criteria

- [ ] `npm pack --dry-run 2>&1 | grep 'schemas/'` returns zero matches (schemas only in dist/).
- [ ] `npm pack --dry-run 2>&1 | grep 'docs/'` shows docs files included.
- [ ] `npm pack --dry-run` does not list root-level `skills/` or `agents/` entries.
- [ ] `package.json` has `repository`, `homepage`, `bugs`, and `keywords` fields.
- [ ] `npm run build && npm pack` succeeds.
- [ ] Install-from-tarball smoke test: `node -e "import('orc-state').then(m => console.log('OK'))"` works.
- [ ] `npm test` passes.
- [ ] No changes to files outside `package.json`.

---

## Tests

No new unit tests. Validation via `npm pack --dry-run` output inspection and install smoke test.

---

## Verification

```bash
# Build and check pack output
npm run build
npm pack --dry-run 2>&1 | grep -E 'total files|skills/|agents/|docs/|schemas/' | head -20

# Verify schemas resolve from dist
npm pack --dry-run 2>&1 | grep 'dist/schemas/'

# Smoke test
npm pack
rm -rf /tmp/orc-111 && mkdir /tmp/orc-111 && cd /tmp/orc-111 && npm init -y && npm install /path/to/orc-state-0.1.0.tgz
node -e "import('orc-state').then(m => console.log('OK'))"
rm -rf /tmp/orc-111

# Full suite
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Removing `skills` and `agents` from `files` means they only ship via `dist/`. If the build script's copy step fails silently, `orc install` breaks.
**Rollback:** `git restore package.json && npm test`
