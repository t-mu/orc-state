---
ref: general/163-pr-cli-commands
feature: general
priority: high
status: done
review_level: light
depends_on:
  - general/162-git-host-adapter
---

# Task 163 — Add Provider-Agnostic PR CLI Commands

Depends on Task 162 (git host adapter).

## Scope

**In scope:**
- Create 4 thin CLI commands: `pr-diff`, `pr-review`, `pr-merge`, `pr-status`
- Register all four in `cli/orc.ts` COMMANDS dict
- Each reads `pr_provider` from config, delegates to git host adapter

**Out of scope:**
- Git host adapter implementation (Task 162)
- Coordinator logic (Task 165)
- Templates (Task 164)

---

## Context

The PR reviewer worker must interact with the git host without knowing which
platform is in use. These CLI commands wrap the git host adapter so the reviewer
calls `orc pr-diff`, not `gh pr diff` or `glab mr diff`. Provider selection is
invisible to the reviewer — it reads from config.

Each command is ~20 lines: read config, get adapter, call method, print result.

**Start here:** `cli/orc.ts` COMMANDS dict (for registration pattern)

**Affected files:**
- `cli/pr-diff.ts` — new
- `cli/pr-review.ts` — new
- `cli/pr-merge.ts` — new
- `cli/pr-status.ts` — new
- `cli/orc.ts` — register commands

---

## Goals

1. Must provide `orc pr-diff <pr_ref>` that prints diff to stdout.
2. Must provide `orc pr-review <pr_ref> --approve|--request-changes --body="..."`.
3. Must provide `orc pr-merge <pr_ref>` that merges the PR.
4. Must provide `orc pr-status <pr_ref>` that prints PR status, and `orc pr-status <pr_ref> --wait` that blocks until CI resolves.
5. Must read `pr_provider` from config — never reference `gh`/`glab` directly.
6. Must exit 1 with descriptive error if `pr_provider` is not configured.

---

## Implementation

### Step 1 — Create pr-diff

**File:** `cli/pr-diff.ts`

```typescript
#!/usr/bin/env node
import { loadCoordinatorConfig } from '../lib/providers.ts';
import { getGitHostAdapter } from '../lib/gitHosts/index.ts';
import { flag } from '../lib/args.ts';

const prRef = process.argv[2] ?? flag('pr-ref');
if (!prRef) { console.error('Usage: orc pr-diff <pr_ref>'); process.exit(1); }

const config = loadCoordinatorConfig();
if (!config.pr_provider) { console.error('pr_provider not configured'); process.exit(1); }

const adapter = getGitHostAdapter(config.pr_provider);
process.stdout.write(adapter.getPrDiff(prRef));
```

### Step 2 — Create pr-review, pr-merge, pr-status

Same pattern. Each: parse args, load config, get adapter, call method, output result.

### Step 3 — Register in orc.ts

**File:** `cli/orc.ts`

Add to COMMANDS dict:
```typescript
'pr-diff': 'pr-diff.ts',
'pr-review': 'pr-review.ts',
'pr-merge': 'pr-merge.ts',
'pr-status': 'pr-status.ts',
```

---

## Acceptance criteria

- [ ] `orc pr-diff <pr_ref>` prints diff to stdout.
- [ ] `orc pr-review <pr_ref> --approve --body="..."` submits approval.
- [ ] `orc pr-review <pr_ref> --request-changes --body="..."` submits findings.
- [ ] `orc pr-merge <pr_ref>` merges the PR.
- [ ] `orc pr-status <pr_ref>` prints PR state.
- [ ] `orc pr-status <pr_ref> --wait` blocks until CI resolves, prints `passing` or `failing`.
- [ ] All commands exit 1 with error if `pr_provider` not configured.
- [ ] All commands exit 1 with usage if `pr_ref` missing.
- [ ] No direct references to `gh`, `glab`, or any platform CLI.
- [ ] Commands registered in `cli/orc.ts`.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add `cli/pr-diff.test.ts`, `cli/pr-review.test.ts`, `cli/pr-merge.test.ts`, `cli/pr-status.test.ts`:

```typescript
it('calls adapter.getPrDiff with the pr_ref argument', () => { ... });
it('exits 1 when pr_provider is not configured', () => { ... });
it('exits 1 when pr_ref is missing', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```
