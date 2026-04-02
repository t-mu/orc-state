---
ref: publish/108-preflight-git-repo-check
feature: publish
priority: normal
status: todo
---

# Task 108 — Add Git Repo Validation to `orc preflight`

Independent.

## Scope

**In scope:**
- Add git repository check to `cli/preflight.ts` — warn if not in a git repo
- Add git repository check to `cli/doctor.ts` — report as a problem

**Out of scope:**
- Changing `orc init` git check (handled in task 106)
- Validating git working tree cleanliness
- Checking disk space or inode availability

---

## Context

### Current state

`orc preflight` and `orc doctor` validate state files, provider binaries, worker health, and claim integrity. Neither checks whether the current directory is inside a git repository. Since the orchestrator relies on git worktrees for task isolation, running outside a git repo will cause failures during task dispatch.

### Desired state

`orc preflight` includes a git repo check and warns if not in a git repo. `orc doctor` includes the same check and reports it as a problem (affecting exit code). This ensures users discover environment issues before they cause dispatch failures.

### Start here

- `cli/preflight.ts` — lightweight health check
- `cli/doctor.ts` — comprehensive health check

**Affected files:**
- `cli/preflight.ts` — add git repo check as a warning
- `cli/doctor.ts` — add git repo check as a problem
- `cli/preflight.test.ts` — add test
- `cli/doctor.test.ts` — add test

---

## Goals

1. Must warn in `orc preflight` when not inside a git repository
2. Must report as a problem in `orc doctor` when not inside a git repository
3. Must not change exit codes for environments that are inside a git repo
4. Must use `git rev-parse --git-dir` for detection (consistent with task 106)

---

## Implementation

### Step 1 — Add git check helper

Create a shared helper (or inline in each file):

```typescript
function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
```

### Step 2 — Add to preflight

**File:** `cli/preflight.ts`

Add early in the check sequence:

```typescript
if (!isGitRepo()) {
  warnings.push('Not inside a git repository — worktree isolation will not work');
}
```

### Step 3 — Add to doctor

**File:** `cli/doctor.ts`

Add as a problem:

```typescript
if (!isGitRepo()) {
  problems.push('Not inside a git repository. Worktree-based task isolation requires git. Run `git init` to fix.');
}
```

---

## Acceptance criteria

- [ ] `orc preflight` outside a git repo prints a warning about git
- [ ] `orc doctor` outside a git repo reports a problem and exits 1
- [ ] Both commands pass cleanly when inside a git repo
- [ ] `orc doctor --json` includes the git check in structured output
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `cli/preflight.test.ts`:

```typescript
it('warns when not inside a git repository', () => { ... });
```

Add to `cli/doctor.test.ts`:

```typescript
it('reports problem when not inside a git repository', () => { ... });
```

---

## Verification

```bash
npx vitest run cli/preflight.test.ts cli/doctor.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
orc preflight
# Expected: both exit 0 in a git repo
```
