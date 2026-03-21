---
ref: ci/4-build-job
feature: ci
priority: normal
status: todo
---

# Task 4 — Implement the Build Job in CI

Depends on Task 1. Blocks Task 5.

## Scope

**In scope:**
- Replace the stub `build` job steps in `.github/workflows/ci.yml` with real steps: install dependencies, run `npm run build`, and upload the `dist/` directory as a workflow artifact
- Ensure the job fails on any TypeScript compilation error

**Out of scope:**
- Changes to the `lint`, `test`, or `deploy` jobs
- Changes to TypeScript configuration (`tsconfig.json`) or source code
- Modifications to `package.json` build script

---

## Context

Task 1 created the CI pipeline skeleton with a stub `build` job. This task fills in the real steps so that every push and pull request to `main` compiles the TypeScript source, fails on type errors, and makes the compiled output available as an artifact for the deploy job.

### Current state

The `build` job in `.github/workflows/ci.yml` contains only a placeholder `run: echo "TODO: build steps"`. No TypeScript compilation occurs in CI and no build artifact is produced.

### Desired state

The `build` job runs `npm run build`. Any TypeScript error causes a non-zero exit, failing the job. On success, the `dist/` directory is uploaded as an artifact named `dist` for downstream use by the `deploy` job.

### Start here

- `.github/workflows/ci.yml` — replace the build job stub steps
- `package.json` — confirm `build` script name and command
- `tsconfig.json` — confirm output directory is `dist/`

**Affected files:**
- `.github/workflows/ci.yml` — update build job steps only

---

## Goals

1. Must run `npm ci` to install dependencies before building.
2. Must run `npm run build` as the build step.
3. Must fail the job if `npm run build` exits non-zero (TypeScript errors or other build failures).
4. Must upload the `dist/` directory as an artifact named `dist`.
5. Must not modify the `lint`, `test`, or `deploy` job sections.
6. Must not introduce any new npm dependencies or scripts.

---

## Implementation

### Step 1 — Replace build job stub in `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Replace the existing build job steps:

```yaml
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Upload dist artifact
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

<!-- Invariant: do not modify the lint, test, or deploy job definitions -->

---

## Acceptance criteria

- [ ] `build` job steps contain `npm ci` followed by `npm run build`.
- [ ] Job exits non-zero if `npm run build` exits non-zero (TypeScript errors).
- [ ] `dist/` directory is uploaded as artifact named `dist` on successful build.
- [ ] No placeholder `echo "TODO"` steps remain in the `build` job.
- [ ] `lint`, `test`, and `deploy` job definitions are unchanged.
- [ ] No changes outside `.github/workflows/ci.yml`.

---

## Tests

No automated tests for CI YAML. Validate manually:

```bash
npx js-yaml .github/workflows/ci.yml
```

---

## Verification

```bash
# Confirm build steps are present
grep -A 20 'build:' .github/workflows/ci.yml

# Validate YAML
npx js-yaml .github/workflows/ci.yml

# Repo-wide checks
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** If the `build` script does not emit output to `dist/`, the artifact upload step will warn or fail.
**Rollback:** Revert the build job steps to the stub. Verify `tsconfig.json` `outDir` matches `dist/` before re-applying.
