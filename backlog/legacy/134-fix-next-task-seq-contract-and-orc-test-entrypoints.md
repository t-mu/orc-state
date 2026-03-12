---
ref: orch/task-134-fix-next-task-seq-contract-and-orc-test-entrypoints
epic: orch
status: done
---

# Task 134 — Fix `next_task_seq` Contract and Orchestrator Test Entrypoints

Independent.

## Scope

**In scope:**
- `mcp/handlers.mjs` — make `next_task_seq` semantics explicit and consistent
- `mcp/handlers.test.mjs` — fix the failing expectation and add coverage for pre/post-create sequence meaning
- Root `package.json` and any orchestrator-specific npm scripts needed to make MCP-targeted verification obvious
- `orchestrator/README.md` or nearby operator/test docs — document the canonical orchestrator test commands

**Out of scope:**
- Changing task numbering format beyond the meaning of `next_task_seq`
- Refactoring unrelated task creation behavior
- Broad CI redesign outside the minimal script/docs changes needed for orchestrator test clarity

## Context

The current MCP handler tests expose an inconsistency around `next_task_seq`: the implementation returns the incremented future value after task creation, while one test expects the prior bootstrapped value. That is a contract ambiguity, not just a broken assertion. Separately, orchestrator-specific tests are easy to invoke incorrectly from the repo root because the root `npm test` path does not target orchestrator suites.

This task should tighten both surfaces. First, define what `next_task_seq` means before and after a task is created. Second, make the intended orchestrator test entrypoints obvious enough that contributors can validate MCP work without accidentally running only game tests or passing unsupported filters.

**Affected files:**
- `mcp/handlers.mjs` — `next_task_seq` return semantics
- `mcp/handlers.test.mjs` — task creation sequence coverage
- `package.json` — root orchestrator test scripts if needed
- `orchestrator/README.md` — orchestrator verification guidance

## Goals

1. Must define and document one stable meaning for `next_task_seq`.
2. Must make handler return values and test expectations agree on that meaning.
3. Must add explicit test coverage for both bootstrapping and post-create sequence behavior.
4. Must provide a clear root-level or orchestrator-level command path for MCP-targeted test verification.
5. Must avoid changing task creation behavior beyond the sequence contract and test ergonomics in scope.

## Implementation

### Step 1 — Normalize the `next_task_seq` contract

**File:** `mcp/handlers.mjs`

```js
// Choose one meaning and document it inline:
// next_task_seq === the next available sequence after this mutation
return { ...newTask, next_task_seq: backlog.next_task_seq };
```

If the implementation already matches the desired meaning, update comments and tests instead of changing code shape unnecessarily.

### Step 2 — Fix and extend tests

**File:** `mcp/handlers.test.mjs`

```js
it('bootstraps next_task_seq from numbered refs before creating a task');
it('returns the next available sequence after create_task succeeds');
```

Keep the test names explicit about whether they assert pre-create or post-create semantics.

### Step 3 — Clarify the canonical test commands

**Files:** `package.json`, `orchestrator/README.md`

```json
"test:orc:mcp": "npm run preflight:node && vitest run -c orchestrator/vitest.config.mjs mcp/*.test.mjs"
```

Document when to use `npm run test:orc`, `npm run test:orc:mcp`, and the full root test suite. Avoid npm argument forwarding patterns that currently produce misleading failures.

## Acceptance criteria

- [ ] `next_task_seq` has one documented meaning in code/tests/docs.
- [ ] The current failing MCP handler test is resolved without ambiguity.
- [ ] Tests cover both sequence bootstrapping and post-create returned value semantics.
- [ ] There is a documented canonical command for orchestrator MCP test verification.
- [ ] Running the documented MCP-targeted test command succeeds without relying on unsupported npm argument forwarding.
- [ ] No changes to files outside the stated scope.

## Tests

Add or update in `mcp/handlers.test.mjs`:

```js
it('bootstraps next_task_seq from numbered task refs when absent', () => { ... });
it('returns the next available sequence after create_task appends a new task', () => { ... });
```

Add a script-level smoke check in docs for:

```bash
npm run test:orc:mcp
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

```bash
nvm use 24 && npm run test:orc:mcp
npm run orc:status
```

## Risk / Rollback

**Risk:** Script changes at the repo root can confuse contributors if the new command overlaps with existing orchestrator test flows or if docs drift again.
**Rollback:** `git restore mcp/handlers.mjs mcp/handlers.test.mjs package.json orchestrator/README.md && nvm use 24 && npm run test:orc`
