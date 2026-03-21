---
ref: general/26-ci-pipeline-setup
feature: general
priority: normal
status: todo
---

# Task 26 — Set Up the CI Pipeline

Independent.

## Scope

**In scope:**
- Creating `.github/workflows/ci.yml` with `push` and `pull_request` triggers on `main`
- Defining three job stubs: `lint`, `test`, `build` using `ubuntu-latest` and Node 24
- Installing npm dependencies in each job

**Out of scope:**
- Configuring the actual lint, test, or build commands (those are Tasks 27–29)
- Adding the deploy job (Task 30)
- Changing any source files or `package.json`

---

## Context

The project has no CI pipeline today. Without one, changes can be merged without verifying lint, tests, or build correctness. This task creates the workflow file and establishes the three-job skeleton so that subsequent tasks can add job-specific logic independently.

**Affected files:**
- `.github/workflows/ci.yml` — created new

---

## Goals

1. Must create `.github/workflows/ci.yml` that triggers on `push` and `pull_request` to `main`.
2. Must define `lint`, `test`, and `build` jobs using `ubuntu-latest`.
3. Must pin the Node version to 24 via `actions/setup-node`.
4. Must run `npm install` (or `npm ci`) as a setup step in each job.
5. Must pass GitHub Actions YAML validation (no syntax errors).

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
      - run: npm ci

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
```

Each job has only the checkout and dependency install steps; the actual run commands will be added by Tasks 27–29.

---

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` exists and is valid YAML.
- [ ] Workflow triggers on `push` and `pull_request` to `main`.
- [ ] `lint`, `test`, and `build` jobs are present, each using `ubuntu-latest` and Node 24.
- [ ] Each job installs npm dependencies before doing anything else.
- [ ] No changes to files outside the stated scope.

---

## Tests

No unit tests apply for a YAML workflow file. Validation is done via verification commands below.

---

## Verification

```bash
# Validate YAML syntax
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('YAML valid')"
nvm use 24 && npm test
```
