---
ref: general/162-git-host-adapter
feature: general
priority: high
status: done
review_level: full
---

# Task 162 — Create Git Host Adapter Interface and GitHub Implementation

Independent.

## Scope

**In scope:**
- Create `lib/gitHosts/interface.ts` — provider-agnostic git host adapter interface
- Create `lib/gitHosts/github.ts` — GitHub implementation via `gh` CLI
- Create `lib/gitHosts/index.ts` — adapter factory
- Tests for the GitHub implementation

**Out of scope:**
- GitLab or Bitbucket implementations (future, same interface)
- CLI wrapper commands (Task 163)
- Coordinator integration (Task 165)
- Config or schema changes (Task 161)

---

## Context

The PR merge strategy requires interacting with a git hosting platform (create PR,
check status, merge, submit reviews). This must be provider-agnostic — the coordinator
and PR reviewer worker call the adapter interface, never platform CLIs directly.

GitHub is the first implementation. Future providers (GitLab via `glab`, Bitbucket, Gitea)
implement the same interface. The factory pattern matches the existing AI provider
adapter in `adapters/index.ts`.

All operations use `spawnSync` with argument arrays — no shell templates, no `exec()`,
no arbitrary command execution from config.

**Start here:** `adapters/interface.ts` (AI adapter pattern to follow for interface design). New files go under `lib/gitHosts/`, not `adapters/`.

**Affected files:**
- `lib/gitHosts/interface.ts` — new
- `lib/gitHosts/github.ts` — new
- `lib/gitHosts/index.ts` — new
- `lib/gitHosts/github.test.ts` — new

---

## Goals

1. Must define a `GitHostAdapter` interface with 8 methods: pushBranch, createPr, checkPrStatus, waitForCi, mergePr, submitReview, getPrBody, getPrDiff.
2. Must implement GitHub adapter using `spawnSync('gh', [...args])` — argument arrays only.
3. Must throw descriptive errors on non-zero exit codes.
4. Must provide a factory function `getGitHostAdapter(provider)`.
5. Must not introduce any npm dependencies.

---

## Implementation

### Step 1 — Define interface

**File:** `lib/gitHosts/interface.ts`

```typescript
export interface GitHostAdapter {
  pushBranch(remote: string, branch: string): void;
  createPr(title: string, branch: string, body: string): string;  // returns PR ref (URL or number)
  checkPrStatus(prRef: string): 'open' | 'merged' | 'closed';
  waitForCi(prRef: string): 'passing' | 'failing';               // blocks until CI resolves
  mergePr(prRef: string): void;
  submitReview(prRef: string, body: string, approve: boolean): void;
  getPrBody(prRef: string): string;
  getPrDiff(prRef: string): string;
}
```

### Step 2 — Implement GitHub adapter

**File:** `lib/gitHosts/github.ts`

Each method calls `spawnSync('gh', [...])` with structured arguments:

```typescript
import { spawnSync } from 'node:child_process';

export class GitHubAdapter implements GitHostAdapter {
  createPr(title: string, branch: string, body: string): string {
    const result = spawnSync('gh', [
      'pr', 'create', '--title', title, '--head', branch, '--body', body,
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error(`gh pr create failed: ${result.stderr}`);
    return result.stdout.trim();  // PR URL
  }
  // ... similar for each method
}
```

Map `checkPrStatus` output: `gh pr view <ref> --json state --jq '.state'` → map `MERGED`/`CLOSED`/`OPEN`.
`waitForCi`: `gh pr checks <ref> --watch` — blocks until all checks resolve. Exit 0 = passing, non-zero = failing.
`submitReview`: `gh pr review <ref> --body <body> --approve` or `--request-changes`.
`getPrDiff`: `gh pr diff <ref>`.

### Step 3 — Create factory

**File:** `lib/gitHosts/index.ts`

```typescript
import { GitHubAdapter } from './github.ts';
import type { GitHostAdapter } from './interface.ts';

export function getGitHostAdapter(provider: string): GitHostAdapter {
  if (provider === 'github') return new GitHubAdapter();
  throw new Error(`Unsupported git host provider: ${provider}. Supported: github`);
}

export type { GitHostAdapter } from './interface.ts';
```

---

## Acceptance criteria

- [ ] `GitHostAdapter` interface defines all 8 methods with correct signatures.
- [ ] `GitHubAdapter` implements all 8 methods using `spawnSync('gh', [...])`.
- [ ] No use of `exec()`, `execSync()`, or shell template strings.
- [ ] Descriptive errors thrown on non-zero exit codes with stderr content.
- [ ] Factory returns `GitHubAdapter` for `'github'`, throws for unknown providers.
- [ ] No npm dependencies added.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add `lib/gitHosts/github.test.ts`:

```typescript
it('createPr calls gh with correct arguments and returns URL', () => { ... });
it('createPr throws on non-zero exit', () => { ... });
it('checkPrStatus maps MERGED/CLOSED/OPEN correctly', () => { ... });
it('waitForCi calls gh pr checks --watch and maps exit code', () => { ... });
it('mergePr calls gh pr merge with --squash', () => { ... });
it('submitReview passes --approve or --request-changes', () => { ... });
it('getPrDiff returns diff output', () => { ... });
it('getPrBody returns body text', () => { ... });
it('factory throws for unsupported provider', () => { ... });
```

Mock `spawnSync` via `vi.mock('node:child_process')`.

---

## Verification

```bash
nvm use 24 && npm test
```
