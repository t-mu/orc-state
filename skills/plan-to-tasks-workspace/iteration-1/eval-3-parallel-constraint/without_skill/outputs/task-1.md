---
ref: ci/1-setup-ci-pipeline
feature: ci
priority: normal
status: todo
---

# Task 1 — Set Up the CI Pipeline Skeleton

Independent.

## Scope

**In scope:**
- Create `.github/workflows/ci.yml` with triggers for `push` and `pull_request` to `main`
- Define the four job stubs: `lint`, `test`, `build`, `deploy` using `ubuntu-latest` and Node 24
- Wire up job-level `needs:` dependencies so `deploy` waits for `lint`, `test`, and `build`

**Out of scope:**
- Actual job step implementations (handled in Tasks 2–5)
- Any changes to `package.json`, source code, or existing scripts

---

## Context

The project has no CI pipeline. Pull requests and merges to `main` are not automatically verified, meaning lint errors, test failures, and build breakage can land undetected.

### Current state

No `.github/workflows/` directory exists. All validation is manual and ad-hoc.

### Desired state

A `ci.yml` workflow file exists with correctly configured triggers and four named jobs (`lint`, `test`, `build`, `deploy`). Jobs run on `ubuntu-latest` with Node 24. `deploy` depends on all three other jobs. Individual job steps are left as stubs to be filled in by subsequent tasks.

### Start here

- `.github/workflows/` — directory to create
- `package.json` — check existing `scripts` entries (lint, test, build) to confirm script names before referencing them in CI

**Affected files:**
- `.github/workflows/ci.yml` — new file; the CI pipeline definition

---

## Goals

1. Must trigger on `push` and `pull_request` targeting `main`.
2. Must define jobs: `lint`, `test`, `build`, and `deploy`.
3. Must use `ubuntu-latest` as the runner for all jobs.
4. Must use Node 24 (exact version) for all jobs.
5. Must set `deploy` to `needs: [lint, test, build]`.
6. Must leave lint, test, build, and deploy step bodies as placeholder `run: echo "TODO"` stubs.

---

## Implementation

### Step 1 — Create `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: echo "TODO: lint steps"

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: echo "TODO: test steps"

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: echo "TODO: build steps"

  deploy:
    runs-on: ubuntu-latest
    needs: [lint, test, build]
    steps:
      - run: echo "TODO: deploy steps"
```

<!-- Invariant: do not add actual step logic here — that is handled in Tasks 2–5 -->

---

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` exists and is valid YAML.
- [ ] Workflow triggers on `push` to `main` and `pull_request` targeting `main`.
- [ ] Four jobs are defined: `lint`, `test`, `build`, `deploy`.
- [ ] All jobs specify `runs-on: ubuntu-latest`.
- [ ] All jobs include an `actions/setup-node` step pinned to Node 24.
- [ ] `deploy` job declares `needs: [lint, test, build]`.
- [ ] No source files, `package.json`, or scripts are modified.

---

## Tests

No automated tests for YAML workflow files. Validate manually with:

```bash
# Validate YAML syntax
npx js-yaml .github/workflows/ci.yml
```

---

## Verification

```bash
# Confirm file was created
ls .github/workflows/ci.yml

# Validate YAML is parseable
npx js-yaml .github/workflows/ci.yml

# Repo-wide checks
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Malformed YAML will cause all CI runs to fail with a parse error.
**Rollback:** Delete `.github/workflows/ci.yml` or revert via `git revert`.
