---
ref: general/149-init-auto-create-backlog-dir
feature: general
priority: high
status: done
---

# Task 149 — Auto-Create Backlog Directory on orc init

Independent.

## Scope

**In scope:**
- Add `mkdirSync(BACKLOG_DOCS_DIR, { recursive: true })` to `cli/init.ts` after `ensureGitignore()`
- Add test in `cli/init.test.ts` verifying directory creation

**Out of scope:**
- Creating the backlog directory in other commands (e.g., `task-create`)
- Adding template files or README inside the backlog directory
- Modifying `lib/paths.ts` or how `BACKLOG_DOCS_DIR` is resolved

---

## Context

After `orc init`, the backlog directory does not exist. If a consumer tries to
create task specs or run `orc backlog-sync-check`, the spec discovery function
(`discoverActiveTaskSpecs`) silently finds no tasks because the directory is
missing. This is confusing for new users.

The correct export is `BACKLOG_DOCS_DIR` from `lib/paths.ts` (line 21), which
respects the `ORC_BACKLOG_DIR` environment variable and config overrides. The
`cli/init.ts` file currently imports only `STATE_DIR` from `lib/paths.ts`.

**Affected files:**
- `cli/init.ts` — add import + mkdirSync call (after line 45)
- `cli/init.test.ts` — add test for directory creation

---

## Goals

1. Must create the configured backlog directory during `orc init`.
2. Must use `BACKLOG_DOCS_DIR` from `lib/paths.ts` (respects env/config overrides).
3. Must not fail if the directory already exists (`recursive: true`).
4. Must have a test verifying the directory is created.

---

## Implementation

### Step 1 — Add import and mkdirSync to cli/init.ts

**File:** `cli/init.ts`

Add to imports:
```typescript
import { mkdirSync } from 'node:fs';
import { BACKLOG_DOCS_DIR } from '../lib/paths.ts';
```

Note: `mkdirSync` must be added to the existing `node:fs` import destructuring
(line 20 already imports `existsSync, unlinkSync, writeFileSync, copyFileSync`).

After `ensureGitignore();` (line 45), add:
```typescript
mkdirSync(BACKLOG_DOCS_DIR, { recursive: true });
```

### Step 2 — Add test

**File:** `cli/init.test.ts`

```typescript
it('creates the backlog directory', async () => {
  // run init in temp dir
  // assert backlog directory exists
  expect(existsSync(join(tmpDir, 'backlog'))).toBe(true);
});
```

---

## Acceptance criteria

- [ ] `orc init` creates the backlog directory if it doesn't exist.
- [ ] Uses `BACKLOG_DOCS_DIR` from `lib/paths.ts`.
- [ ] Does not fail if directory already exists.
- [ ] Test in `cli/init.test.ts` verifies directory creation.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `cli/init.test.ts`:

```typescript
it('creates the backlog directory during init', () => { ... });
it('does not fail if backlog directory already exists', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```
