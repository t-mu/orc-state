---
ref: general/30-ci-deploy-job
feature: general
priority: normal
status: todo
depends_on:
  - general/27-ci-lint-job
  - general/28-ci-test-job
  - general/29-ci-build-job
---

# Task 30 — Add Deploy Job to CI

Depends on Tasks 27, 28, and 29.

## Scope

**In scope:**
- Adding a `deploy` job to `.github/workflows/ci.yml` that runs only on merge to `main`
- Gating the deploy job on `lint`, `test`, and `build` all passing via `needs:`
- Invoking `scripts/deploy.sh` as the deploy step

**Out of scope:**
- Writing or modifying `scripts/deploy.sh`
- Configuring staging environment credentials or secrets (assumed pre-existing)
- Touching the `lint`, `test`, or `build` jobs

---

## Context

Tasks 27, 28, and 29 complete the lint, test, and build jobs respectively. This task adds the final `deploy` job that runs only on pushes to `main` (not on pull requests) and only when all three upstream jobs succeed. The deploy script at `scripts/deploy.sh` is assumed to exist and be executable.

**Affected files:**
- `.github/workflows/ci.yml` — `deploy` job added

---

## Goals

1. Must add a `deploy` job that declares `needs: [lint, test, build]`.
2. Must restrict the deploy job to run only on `push` to `main` (not on pull requests).
3. Must invoke `bash scripts/deploy.sh` as the deploy step.
4. Must not run the deploy job if any of `lint`, `test`, or `build` fail.
5. Must leave the file valid YAML after the edit.

---

## Implementation

### Step 1 — Add `deploy` job to `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Append the following job definition:

```yaml
  deploy:
    runs-on: ubuntu-latest
    needs: [lint, test, build]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: bash scripts/deploy.sh
```

The `needs: [lint, test, build]` declaration ensures the deploy job is skipped automatically if any upstream job fails. The `if:` condition restricts execution to push events on `main`, so pull request runs never trigger a deploy.

---

## Acceptance criteria

- [ ] A `deploy` job exists in `.github/workflows/ci.yml`.
- [ ] The `deploy` job declares `needs: [lint, test, build]`.
- [ ] The `deploy` job only runs on `push` to `main`, not on pull requests.
- [ ] The deploy step invokes `scripts/deploy.sh`.
- [ ] The `lint`, `test`, and `build` jobs are unchanged.
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
# Confirm scripts/deploy.sh exists
test -f scripts/deploy.sh && echo "deploy.sh present" || echo "WARNING: deploy.sh missing"
nvm use 24 && npm test
```
