---
ref: general/29-ci-build-job
feature: general
priority: normal
status: todo
depends_on:
  - general/26-ci-pipeline-setup
---

# Task 29 — Add Build Job to CI

Depends on Task 26. Blocks Task 30.

## Scope

**In scope:**
- Adding `npm run build` to the `build` job in `.github/workflows/ci.yml`
- Failing the job on any TypeScript compilation error
- Uploading `dist/` as a CI artifact for the deploy job

**Out of scope:**
- Creating or modifying TypeScript configuration (`tsconfig.json`)
- Adding or changing `package.json` scripts
- Touching the `lint` or `test` jobs
- Configuring the deploy job (Task 30)

---

## Context

Task 26 creates the CI pipeline with a `build` job skeleton that only installs dependencies. This task adds the build command and artifact upload so that the deploy job (Task 30) can consume the compiled output. TypeScript compilation errors cause a non-zero exit from `npm run build`, which natively fails the job.

This task is independent of Tasks 27 and 28 (lint and test) and can be executed in parallel with them.

**Affected files:**
- `.github/workflows/ci.yml` — `build` job extended with run and upload steps

---

## Goals

1. Must add `npm run build` as a step in the `build` job.
2. Must fail the job if `npm run build` exits non-zero (TypeScript errors).
3. Must upload the `dist/` directory as a GitHub Actions artifact named `dist`.
4. Must not modify the `lint` or `test` jobs.
5. Must leave the file valid YAML after the edit.

---

## Implementation

### Step 1 — Add build run and artifact upload to `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Extend the `build` job steps (after `npm ci`) to add:

```yaml
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

The resulting `build` job steps section:

```yaml
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

---

## Acceptance criteria

- [ ] The `build` job in `.github/workflows/ci.yml` runs `npm run build`.
- [ ] The job fails if `npm run build` exits non-zero.
- [ ] The `dist/` directory is uploaded as an artifact named `dist`.
- [ ] The `lint` and `test` jobs are unchanged.
- [ ] `.github/workflows/ci.yml` remains valid YAML.
- [ ] No changes to files outside the stated scope.

---

## Tests

No unit tests apply. Verification is done via YAML validation and manual review.

---

## Verification

```bash
# Validate YAML syntax
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('YAML valid')"
nvm use 24 && npm test
```
