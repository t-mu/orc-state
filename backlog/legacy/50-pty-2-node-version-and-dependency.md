# Task 50 — Bump Node to 24 and Add `node-pty` Dependency

No dependencies. Blocks Task 51.

---

## Scope

**In scope:**
- `orchestrator/package.json` — bump `engines.node` to `>=24`, add `node-pty@1.1.0` to `dependencies`
- `.nvmrc` in repo root (if it exists) — update to `24`
- `scripts/node_version_guard.mjs` (if it checks a hardcoded version) — update the required version
- Run `npm install` from repo root to update `package-lock.json`

**Out of scope:**
- Any source code changes — only package metadata and lockfile
- `vitest.config` or test configuration — no changes needed
- CI configuration files — out of scope for this task

---

## Context

node-pty is a native Node.js addon that provides PTY (pseudo-terminal) creation and I/O. It replaces the tmux external process as the mechanism for running agent CLI sessions. Unlike tmux — which is an external binary anyone can shell out to — node-pty creates PTY file descriptors that are owned by the Node.js process, making the coordinator the sole owner of all agent sessions.

`node-pty@1.1.0` is the current release. It is a native addon compiled via `node-gyp`. On most developer machines (macOS with Xcode CLT, Linux with build-essential) `npm install` will fetch a prebuilt binary automatically via `prebuild-install`. If no prebuilt is found for the platform/Node version combination, it falls back to compiling from source, which requires a C++ toolchain.

Node 24 (LTS as of 2025) is already installed via nvm. The `engines` field and node version guard are updated so CI and local checks stay in sync.

**Affected files:**
- `orchestrator/package.json` — primary change
- `.nvmrc` — if present at repo root
- `scripts/node_version_guard.mjs` — if it enforces a specific Node version

---

## Goals

1. Must add `"node-pty": "1.1.0"` to the `dependencies` block of `orchestrator/package.json`.
2. Must update `engines.node` in `orchestrator/package.json` to `">=24"`.
3. Must update `.nvmrc` (if present) to `24`.
4. Must update `scripts/node_version_guard.mjs` (if it checks a version number) to require `>= 24`.
5. After `npm install`, `node -e "import('node-pty')"` must resolve without error.
6. No source files outside the scope list may change.

---

## Implementation

### Step 1 — Update `orchestrator/package.json`

In the `engines` block, change:
```json
"node": ">=22"
```
to:
```json
"node": ">=24"
```

In the `dependencies` block, add:
```json
"node-pty": "1.1.0"
```

Full `dependencies` block after the change:
```json
"dependencies": {
  "@inquirer/prompts": "^7.5.2",
  "ajv": "8.18.0",
  "node-pty": "1.1.0"
}
```

### Step 2 — Update `.nvmrc` (if present)

Check if `/.nvmrc` exists at the repo root. If it does, set its contents to:
```
24
```

### Step 3 — Update node version guard (if applicable)

Check `scripts/node_version_guard.mjs`. If it contains a hardcoded minimum version number (e.g. `22`), update it to `24`.

### Step 4 — Install

From the repo root:
```bash
nvm use 24 && npm install
```

This updates `package-lock.json`. Commit the lockfile change together with the `package.json` change.

---

## Acceptance criteria

- [ ] `orchestrator/package.json` `dependencies` contains `"node-pty": "1.1.0"`.
- [ ] `orchestrator/package.json` `engines.node` is `">=24"`.
- [ ] `node_modules/node-pty` exists after `npm install`.
- [ ] `node -e "import('node-pty').then(() => console.log('ok'))"` prints `ok` (run from `orchestrator/`).
- [ ] Existing tests still pass: `nvm use 24 && npm run test:orc:unit`.
- [ ] No source `.mjs` files are modified.

---

## Tests

No new tests — this task only changes package metadata. The existing unit test run under Node 24 acts as the regression check.

---

## Verification

```bash
nvm use 24
npm install
node -e "import('node-pty').then(m => console.log('node-pty loaded, spawn:', typeof m.default?.spawn))"
# Expected: node-pty loaded, spawn: function

npm run test:orc:unit
# Expected: all existing tests pass
```

---

## Risk / Rollback

**Risk:** `node-pty` fails to find a prebuilt binary for the platform and `node-gyp` compilation fails (missing build tools).

**Rollback:** Remove the `node-pty` entry from `package.json`, run `npm install`, revert `package-lock.json`. The tmux adapter remains functional until Task 52 switches the factory. Install Xcode CLT (`xcode-select --install` on macOS) or `build-essential` (Linux) before retrying.
