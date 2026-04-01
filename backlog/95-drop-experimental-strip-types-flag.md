---
ref: publish/95-drop-experimental-strip-types-flag
feature: publish
priority: normal
status: done
depends_on:
  - publish/94-emit-dts-declarations
---

# Task 95 — Drop Redundant --experimental-strip-types Flag

Depends on Task 94 (declaration emit should be in place first so the build script doesn't reference the flag).

## Scope

**In scope:**
- Remove `--experimental-strip-types` from CLI shebang in `cli/orc.ts`
- Remove the flag from `buildNodeArgs()` in `cli/orc.ts`
- Remove the flag from `scripts.task:done` in `package.json`
- Remove the flag from `cli/start-session.ts` spawn calls
- Update test files that pass the flag in `spawnSync` calls
- Update `test-fixtures/ptySupport.ts` and `test-fixtures/fake-provider-cli.ts`
- Update `test-fixtures/bin/*` stubs
- Update `.mcp.json`, `README.md`, `AGENTS.md`, and `skills/orc-commands/SKILL.md`
- Leave backlog specs untouched (historical documents)

**Out of scope:**
- Changing any runtime logic beyond flag removal
- Modifying backlog/ markdown files (they are historical records)
- Removing the `tsx` dependency (still needed for `watch` command)

---

## Context

Node 24 strips TypeScript types by default — the `--experimental-strip-types` flag is redundant. Verified on Node 24.14.1: `node -e "const x: number = 1; console.log(x)"` works without the flag.

The flag currently appears in 47 files across the codebase. Most are test files that spawn CLI subcommands via `spawnSync`. The shebang in `cli/orc.ts` also uses `#!/usr/bin/env -S node --experimental-strip-types` where `-S` (multi-arg split) has portability concerns on non-Linux systems.

### Current state
- `cli/orc.ts` line 1: `#!/usr/bin/env -S node --experimental-strip-types`
- `buildNodeArgs()` passes `--experimental-strip-types` to all non-watch subcommands
- `cli/start-session.ts` passes the flag when spawning coordinator and MCP server
- 30+ test files pass the flag in spawn calls
- `scripts.task:done` uses `node --experimental-strip-types cli/task-mark-done.ts`

### Desired state
- `cli/orc.ts` line 1: `#!/usr/bin/env node`
- `buildNodeArgs()` returns `[scriptPath, ...rest]` without the flag
- All spawn calls in production and test code drop the flag
- `scripts.task:done` uses `node cli/task-mark-done.ts`

### Start here
- `cli/orc.ts` — shebang and `buildNodeArgs()`
- `cli/start-session.ts` — spawn calls
- `cli/orc.test.ts` — tests for `buildNodeArgs()`

**Affected files:**
- `cli/orc.ts` — shebang + buildNodeArgs
- `cli/start-session.ts` — spawn arguments
- `package.json` — scripts.task:done
- `test-fixtures/ptySupport.ts`, `test-fixtures/fake-provider-cli.ts`
- `test-fixtures/bin/claude`, `test-fixtures/bin/codex`, `test-fixtures/bin/gemini`
- 30+ `cli/*.test.ts` files
- `.mcp.json`, `README.md`, `AGENTS.md`, `skills/orc-commands/SKILL.md`

---

## Goals

1. Must: No runtime `.ts` file or script passes `--experimental-strip-types`.
2. Must: `cli/orc.ts` shebang is `#!/usr/bin/env node`.
3. Must: All CLI subcommands still execute correctly without the flag.
4. Must: All tests pass.
5. Must: Documentation references are updated.
6. Must: Backlog spec files are NOT modified.

---

## Implementation

### Step 1 — Update cli/orc.ts

**File:** `cli/orc.ts`

- Line 1: change shebang to `#!/usr/bin/env node`
- `buildNodeArgs()`: return `[scriptPath, ...rest]` (remove `'--experimental-strip-types'` from array)

### Step 2 — Update cli/start-session.ts

**File:** `cli/start-session.ts`

Remove `--experimental-strip-types` from coordinator and MCP server spawn args.

### Step 3 — Update package.json scripts

**File:** `package.json`

Change `"task:done"` from `"node --experimental-strip-types cli/task-mark-done.ts"` to `"node cli/task-mark-done.ts"`.

### Step 4 — Update test fixtures

**Files:** `test-fixtures/ptySupport.ts`, `test-fixtures/fake-provider-cli.ts`, `test-fixtures/bin/*`

Remove the flag from all spawn calls and shebang lines.

### Step 5 — Update test files

**Files:** All `cli/*.test.ts` and `mcp/*.test.ts` files

Remove `--experimental-strip-types` from `spawnSync` argument arrays.

### Step 6 — Update documentation

**Files:** `.mcp.json`, `README.md`, `AGENTS.md`, `skills/orc-commands/SKILL.md`

Remove or simplify references to the flag.

---

## Acceptance criteria

- [ ] `grep -r 'experimental-strip-types' --include='*.ts' --include='*.json' .` returns zero matches (excluding node_modules/ and backlog/).
- [ ] `cli/orc.ts` shebang is exactly `#!/usr/bin/env node`.
- [ ] `orc status` works without the flag.
- [ ] `npm test` passes.
- [ ] Backlog `.md` files are unchanged.

---

## Tests

No new tests. Existing tests validate CLI behavior — they must all pass after flag removal.

---

## Verification

```bash
# Verify no runtime references remain
grep -r 'experimental-strip-types' --include='*.ts' --include='*.json' . | grep -v node_modules | grep -v backlog/

# Verify CLI works
node cli/orc.ts status

# Full suite
npm test
```

---

## Risk / Rollback

**Risk:** If any Node 24 installation does NOT have type stripping enabled by default, CLI will fail with syntax errors. Mitigated by: `engines: "node": ">=24"` in package.json, and verified on Node 24.14.1.
**Rollback:** `git restore .`
