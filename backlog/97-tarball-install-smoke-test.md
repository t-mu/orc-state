---
ref: publish/97-tarball-install-smoke-test
feature: publish
priority: normal
status: todo
depends_on:
  - publish/94-emit-dts-declarations
  - publish/95-drop-experimental-strip-types-flag
  - publish/96-prepublish-guard-and-files-audit
---

# Task 97 — Tarball Install Smoke Test

Depends on Tasks 94, 95, 96 (all package changes must land first).

## Scope

**In scope:**
- Run `npm pack` to produce a tarball
- Install the tarball in a clean temp directory
- Verify: library imports resolve and types are available
- Verify: `npx orc --help` works via the bin link
- Verify: no missing dependency errors on import
- Document results and any fixes needed

**Out of scope:**
- Publishing to npm
- Running the full orchestrator end-to-end
- Changing code — this is a validation-only task

---

## Context

`npm pack --dry-run` shows what files would be included, but doesn't catch broken exports, missing dependencies, or bad bin links. An actual install-from-tarball in a clean project is the definitive smoke test before publishing.

### Current state
- `pack:dry` script exists and works
- No install-from-tarball test has been performed

### Desired state
- Confirmed: `npm install <tarball>` succeeds in a clean project
- Confirmed: `import { createAdapter } from '@t-mu/orc-state'` resolves
- Confirmed: TypeScript sees `.d.ts` declarations
- Confirmed: `npx orc --help` prints usage

### Start here
- `package.json` — `exports`, `bin`, `types`, `files`

**Affected files:**
- None — validation only

---

## Goals

1. Must: `npm pack` produces a tarball without errors.
2. Must: `npm install <tarball>` succeeds in a clean directory with no peer dep warnings.
3. Must: `import { createAdapter } from '@t-mu/orc-state'` works at runtime.
4. Must: TypeScript resolves types from the package (test with a minimal `tsconfig` and `tsc --noEmit`).
5. Must: `npx orc --help` prints usage output.

---

## Implementation

### Step 1 — Pack

```bash
npm run build:types
npm pack
```

### Step 2 — Install in clean directory

```bash
mkdir /tmp/orc-smoke-test && cd /tmp/orc-smoke-test
npm init -y
npm install /path/to/t-mu-orc-state-0.1.0.tgz
```

### Step 3 — Test runtime import

```bash
node -e "import('@t-mu/orc-state').then(m => console.log('OK:', Object.keys(m)))"
```

### Step 4 — Test type resolution

Create a minimal test file and tsconfig, run `tsc --noEmit`:

```typescript
import { createAdapter } from '@t-mu/orc-state';
// Should resolve without errors
```

### Step 5 — Test bin link

```bash
npx orc --help
```

---

## Acceptance criteria

- [ ] `npm pack` exits 0.
- [ ] `npm install <tarball>` exits 0 in a clean directory.
- [ ] Runtime import resolves all 9 public exports.
- [ ] `tsc --noEmit` resolves types without `allowImportingTsExtensions`.
- [ ] `npx orc --help` prints usage.
- [ ] Any failures are documented with root cause and fix proposal.

---

## Tests

No new unit tests. This is a manual validation task.

---

## Verification

The task IS the verification. Results should be recorded in the commit message or a comment on the task.

---

## Risk / Rollback

No risk — read-only validation task. If failures are found, they become follow-up tasks.
