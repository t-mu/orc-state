---
ref: publish/105-exclude-eval-artifacts-from-pack
feature: publish
priority: high
status: done
---

# Task 105 — Exclude Evaluation Artifacts from npm Pack

Independent.

## Scope

**In scope:**
- Add `.npmignore` entries to exclude `skills/plan-to-tasks-workspace/` from the published tarball
- Verify tarball size reduction with `npm pack --dry-run`

**Out of scope:**
- Removing the evaluation artifacts from git (they may be useful for development)
- Changing the `files` field in `package.json`
- Modifying any other packaging configuration

---

## Context

### Current state

The `package.json` `files` field includes `"skills"`, which pulls in `skills/plan-to-tasks-workspace/` — a 472KB directory containing 126+ evaluation result files (metrics, grading data, timing, benchmarks). These are development artifacts from skill evaluation runs that have no value to consumers.

### Desired state

`npm pack` excludes all evaluation/workspace artifacts. The tarball contains only the core skill directories needed at runtime (`create-task`, `orc-commands`, `plan-to-tasks`, `worker-inspect`, etc.).

### Start here

- `.npmignore` — existing ignore file (7 lines)
- `skills/plan-to-tasks-workspace/` — the directory to exclude

**Affected files:**
- `.npmignore` — add exclusion pattern

---

## Goals

1. Must exclude `skills/plan-to-tasks-workspace/` from `npm pack` output
2. Must not break existing `.npmignore` exclusions (tests, vitest config, e2e)
3. Must reduce published tarball size by ~472KB

---

## Implementation

### Step 1 — Add exclusion to .npmignore

**File:** `.npmignore`

Add at the end:

```
# Development evaluation artifacts
skills/plan-to-tasks-workspace/
```

---

## Acceptance criteria

- [ ] `npm pack --dry-run` output does not list any files under `skills/plan-to-tasks-workspace/`
- [ ] `npm pack --dry-run` still includes core skill directories (`skills/create-task/`, `skills/orc-commands/`, etc.)
- [ ] Existing `.npmignore` patterns still exclude test files and vitest config
- [ ] No changes to files outside the stated scope

---

## Tests

No new tests needed — this is a packaging-only change.

---

## Verification

```bash
npm pack --dry-run 2>&1 | grep plan-to-tasks-workspace
# Expected: no output (nothing matched)
```

```bash
npm pack --dry-run 2>&1 | grep 'skills/'
# Expected: lists only core skill directories
```

```bash
nvm use 24 && npm test
```
