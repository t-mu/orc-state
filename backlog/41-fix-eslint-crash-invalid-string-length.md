---
ref: general/41-fix-eslint-crash-invalid-string-length
title: "41 Fix Eslint Crash Invalid String Length"
status: done
feature: general
task_type: fix
priority: high
---

## Context

`npm test` always fails at the ESLint pretest step with:

```
ESLint: 10.0.3
RangeError: Invalid string length
    at .../eslint/lib/cli-engine/formatters/stylish.js:102:5
    at Array.forEach (...)
    at module.exports (.../eslint/lib/cli-engine/formatters/stylish.js:55:10)
    at Object.format (.../eslint/lib/eslint/eslint.js:1271:12)
    at printResults (.../eslint/lib/cli.js:118:33)
    at async Object.execute (.../eslint/lib/cli.js:477:4)
    at async main (.../eslint/bin/eslint.js:175:19)
```

This is pre-existing — confirmed present before tasks 37 and 40. It blocks the
`npm test` verification step for every worker, meaning the verification
checklist cannot be fully satisfied.

The `RangeError: Invalid string length` in the stylish formatter is typically
caused by ESLint attempting to lint an extremely large file (e.g. a SQLite
`.db` file or a large binary) and constructing a diagnostic string that exceeds
V8's maximum string length.

## Likely Root Cause

`eslint.config.mjs` does not explicitly ignore:
- `.orc-state/` (contains `events.db`, `events.jsonl.migrated`, large PTY logs)
- `.worktrees/` (contains hundreds of copies of all source files)

ESLint's `projectService: true` setting causes it to discover and lint files
matched by the tsconfig, which may include these directories.

## Acceptance Criteria

1. `npx eslint .` completes without crashing (exit 0 or exits with lint
   warnings/errors only — no `RangeError`).
2. `npm test` completes its pretest step without the `RangeError` crash.
3. The fix does not suppress any legitimate lint errors in source files
   (`lib/`, `cli/`, `adapters/`, `mcp/`, `types/`, `tests/`).
4. All existing Vitest tests continue to pass.

## Implementation Plan

1. Identify which file(s) ESLint is choking on:
   ```bash
   npx eslint --debug . 2>&1 | grep "Linting" | tail -20
   ```
   Or bisect by adding ignores progressively.

2. Add the offending paths to the `ignores` array in `eslint.config.mjs`:
   ```js
   ignores: [
     'dist/**',
     'build/**',
     'coverage/**',
     'node_modules/**',
     '.orc-state/**',   // ← add
     '.worktrees/**',   // ← add
     'eslint.config.mjs',
     'vitest.config.mjs',
     'vitest.e2e.config.mjs',
     'vitest.integration.config.mjs',
   ],
   ```

3. Verify `npx eslint .` exits cleanly.
4. Run `npm test` to confirm the pretest passes end-to-end.

## Files to Change

- `eslint.config.mjs` — add ignore patterns

## Verification

```bash
npx eslint .
npm test
```
