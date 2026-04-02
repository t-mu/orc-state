---
ref: publish/106-init-provider-binary-validation
feature: publish
priority: high
status: todo
---

# Task 106 — Add Provider Binary Validation to `orc init`

Independent.

## Scope

**In scope:**
- After provider selection in `cli/init.ts`, check each selected provider binary is on PATH
- Print a clear warning if a binary is missing, but do not block init completion
- Add git repo validation — exit 1 if not inside a git repository

**Out of scope:**
- Validating provider authentication/API keys (that's task 107)
- Changing the interactive prompts or provider selection flow
- Modifying `orc start-session`

---

## Context

### Current state

`orc init --provider=claude` succeeds even if the `claude` binary is not installed. The user only discovers the problem later when `orc start-session` fails. Similarly, init succeeds in a non-git directory, but worktree creation fails later during task dispatch.

### Desired state

`orc init` validates prerequisites upfront:
1. Checks that the working directory is inside a git repository (hard fail if not)
2. Checks that each selected provider binary is on PATH (warn if missing, do not block)

This gives users actionable feedback at setup time rather than mysterious failures later.

### Start here

- `cli/init.ts` — main init handler
- `lib/binaryCheck.ts` — existing binary detection logic

**Affected files:**
- `cli/init.ts` — add git check and binary validation after provider selection
- `cli/init.test.ts` — add tests for new validation paths

---

## Goals

1. Must exit 1 with a clear message if `git rev-parse --git-dir` fails (not a git repo)
2. Must warn (not error) when a selected provider binary is not found on PATH
3. Must not change the success/failure semantics of init for valid environments
4. Must work in both interactive TTY and non-TTY (`--provider`) modes

---

## Implementation

### Step 1 — Add git repo check early in init

**File:** `cli/init.ts`

Add near the top of the handler, before state initialization:

```typescript
import { execSync } from 'node:child_process';

// Validate git repo
try {
  execSync('git rev-parse --git-dir', { stdio: 'pipe' });
} catch {
  cliError('Must run inside a git repository. Run `git init` first.');
}
```

### Step 2 — Add binary check after provider selection

**File:** `cli/init.ts`

After providers are selected (both TTY and non-TTY paths), validate each:

```typescript
import { existsSync } from 'node:fs';
import { resolve as resolveBinary } from '../lib/binaryCheck.ts';

for (const provider of selectedProviders) {
  const binary = resolveBinary(provider);
  if (!binary) {
    console.warn(`⚠️  Warning: '${provider}' binary not found on PATH. Install it before running orc start-session.`);
  }
}
```

Adapt to the actual binary check API — inspect `lib/binaryCheck.ts` for the correct function signature.

### Step 3 — Add tests

**File:** `cli/init.test.ts`

Add tests for:
- Init fails with exit 1 when not in a git repo
- Init warns when provider binary is missing but still succeeds
- Init succeeds without warnings when binary is present

---

## Acceptance criteria

- [ ] `orc init` in a non-git directory exits 1 with message containing "git repository"
- [ ] `orc init --provider=nonexistent` prints a warning about missing binary but completes successfully
- [ ] `orc init --provider=claude` in a git repo with `claude` installed shows no warning
- [ ] Warning message includes the provider name and actionable guidance
- [ ] Non-TTY mode (`--provider` flag) also triggers both validations
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `cli/init.test.ts`:

```typescript
it('exits 1 with clear message when not in a git repository', () => { ... });
it('warns when selected provider binary is not on PATH', () => { ... });
it('succeeds without warning when provider binary is available', () => { ... });
```

---

## Verification

```bash
npx vitest run cli/init.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: exits 0
```
