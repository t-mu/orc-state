---
ref: ci/5-deploy-job
feature: ci
priority: normal
status: todo
---

# Task 5 — Implement the Deploy Job in CI

Depends on Tasks 2, 3, and 4. Blocks nothing.

## Scope

**In scope:**
- Replace the stub `deploy` job steps in `.github/workflows/ci.yml` with real steps: check out code, download the `dist` artifact, and run `scripts/deploy.sh`
- Restrict the deploy job to run only on merges to `main` (not on pull requests)

**Out of scope:**
- Changes to `scripts/deploy.sh`
- Changes to the `lint`, `test`, or `build` jobs
- Secrets configuration (assumed already present in the repository settings)
- Any infrastructure or environment provisioning

---

## Context

Tasks 2, 3, and 4 implement the lint, test, and build jobs. This task completes the pipeline by wiring up the deploy job so that a successful merge to `main` automatically deploys to staging via the existing `scripts/deploy.sh` script.

### Current state

The `deploy` job in `.github/workflows/ci.yml` contains only a placeholder `run: echo "TODO: deploy steps"`. No deployment occurs automatically on merge.

### Desired state

On merge to `main`, after `lint`, `test`, and `build` all pass, the `deploy` job downloads the `dist` artifact produced by the `build` job and runs `scripts/deploy.sh`. The job is gated to `main` pushes only so pull requests do not trigger a deployment.

### Start here

- `.github/workflows/ci.yml` — replace the deploy job stub steps
- `scripts/deploy.sh` — review the script interface (expected env vars, arguments, exit codes)

**Affected files:**
- `.github/workflows/ci.yml` — update deploy job steps only

---

## Goals

1. Must only run on `push` events to `main` (not on `pull_request` events).
2. Must declare `needs: [lint, test, build]` (already set in Task 1 skeleton; confirm it remains).
3. Must download the `dist` artifact uploaded by the `build` job.
4. Must run `scripts/deploy.sh` as the deployment step.
5. Must fail the job if `scripts/deploy.sh` exits non-zero.
6. Must not modify the `lint`, `test`, or `build` job sections.

---

## Implementation

### Step 1 — Replace deploy job stub in `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Replace the existing deploy job steps:

```yaml
  deploy:
    runs-on: ubuntu-latest
    needs: [lint, test, build]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Download dist artifact
        uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/
      - name: Deploy to staging
        run: bash scripts/deploy.sh
```

<!-- Invariant: do not modify the lint, test, or build job definitions -->
<!-- Invariant: keep needs: [lint, test, build] — set in Task 1 -->

---

## Acceptance criteria

- [ ] `deploy` job only runs when `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`.
- [ ] `deploy` job declares `needs: [lint, test, build]`.
- [ ] `deploy` job downloads the `dist` artifact before running the deploy script.
- [ ] `deploy` job runs `bash scripts/deploy.sh`.
- [ ] Job exits non-zero if `scripts/deploy.sh` exits non-zero.
- [ ] No placeholder `echo "TODO"` steps remain in the `deploy` job.
- [ ] Pull requests do not trigger the deploy job.
- [ ] `lint`, `test`, and `build` job definitions are unchanged.
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
# Confirm deploy steps and condition are present
grep -A 25 'deploy:' .github/workflows/ci.yml

# Validate YAML
npx js-yaml .github/workflows/ci.yml

# Repo-wide checks
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** If `scripts/deploy.sh` expects specific environment variables (credentials, endpoint URLs) that are not set as GitHub secrets, the deploy step will fail at runtime.
**Rollback:** Revert the deploy job steps to the stub, or add the missing secrets in GitHub repository settings before re-enabling.
