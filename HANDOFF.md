# Handoff: Test TypeScript Migration

## Branch and location

- **Branch:** `feat/test-ts-migration`
- **Worktree:** `/Users/teemu/code/orc-state/.worktrees/test-ts-migration`
- **Base:** `main` (commit `1f38f3d` — full source TS migration)

---

## What has been completed

All 66 test files have been renamed from `.mjs` to `.ts` and committed:

- All imports updated: `from './foo.mjs'` → `from './foo.ts'`
- `test-fixtures/ptySupport.mjs` → `.ts`
- `test-fixtures/fake-provider-cli.mjs` → `.ts` (shebang updated)
- `test-fixtures/bin/` wrappers updated to call `.ts` entry point
- `vitest.config.mjs`, `vitest.integration.config.mjs`, `vitest.e2e.config.mjs` — include patterns changed to `**/*.test.ts`
- 63 of 66 test files are already type-clean

---

## Remaining TypeScript errors

**Total: 310 errors across 3 files.**

Run to verify current state:
```bash
cd /Users/teemu/code/orc-state/.worktrees/test-ts-migration
npx tsc --noEmit 2>&1 | grep "error TS" | sed 's|([0-9]*,[0-9]*).*||' | sort | uniq -c | sort -rn
```

### coordinator.test.ts — 158 errors

**Root causes:**

1. `let dir` declared without type in `beforeEach` scope → cascade of TS7005/TS7034
   ```ts
   // Fix: add type
   let dir: string;
   ```

2. Seed arrays typed as `never[]` — the `agents: []` and `tasks: []` array literals infer `never[]` when passed to a function expecting `Agent[]`/`Task[]`:
   ```ts
   // Fix: use typed helper or explicit cast
   agents: [] as Agent[],
   tasks: [] as Task[],
   ```

3. `JSON.parse(readFileSync(..., 'utf8'))` returns `unknown` — accessing `.agents`, `.claims` on it:
   ```ts
   // Fix: cast the parse result
   const state = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as AgentsState;
   state.agents.filter(...)
   ```

4. Callback parameters implicitly `any` because their parent array is `unknown`:
   - Fix by typing the parsed JSON first (see above), then the callbacks infer.

**Imports needed at top of file:**
```ts
import type { Agent, Task, AgentsState, ClaimsState, Backlog } from './types/index.ts';
```

---

### e2e/orchestrationLifecycle.e2e.test.ts — 88 errors

**Root causes:**

1. `let dir` declared without type → same cascade as coordinator.test.ts
   ```ts
   let dir: string;
   ```

2. `let startedRuns` inferred as `any[]`:
   ```ts
   // Fix:
   let startedRuns: string[] = [];
   ```

3. Callback parameters on `readAgents(dir)` / `readClaims(dir)` / `readBacklog(dir)` results where the functions return typed values — if `dir` is `any`, TypeScript can't infer the callback parameter types. Fixing `let dir: string` resolves most of these.

4. One `TS2322: Type 'undefined' is not assignable to type 'never'` at line 503 — a `.find()` result used without null-check:
   ```ts
   // Fix: add non-null assertion or check
   const claim = claims.find(...);
   if (!claim) throw new Error('claim not found');
   ```

**Imports needed:**
```ts
import type { Agent, Task, Claim } from '../types/index.ts';
```

---

### mcp/handlers.test.ts — 64 errors

**Root causes:**

1. Line 402: `Object is of type 'unknown'` — a `JSON.parse()` result used directly:
   ```ts
   // Fix: cast to expected type
   const result = JSON.parse(response) as { content: { text: string }[] };
   ```

2. Lines 451, 454: `.ref` and `.some` don't exist on `{ next_task_seq: unknown }` — the parsed response object shape is wrong. The response from the MCP handler is typed as a specific shape; cast to match:
   ```ts
   const parsed = JSON.parse(text) as Backlog;
   ```

3. Line 454, parameter `task` implicitly `any` in `.some(task => ...)` — fixed by typing the parent array.

**Imports needed:**
```ts
import type { Backlog, Task } from '../types/index.ts';
```

---

## Fix strategy by error category

| Error | Count | Fix |
|-------|-------|-----|
| TS7005 — variable implicitly `any` | ~140 | Add `: string` (or appropriate type) to `let dir` and similar declarations |
| TS7006 — parameter implicitly `any` | ~40 | Fix parent variable type first; most cascade from TS7005 |
| TS7034 — variable implicitly `any` in some locations | ~15 | Same as TS7005 |
| TS2322 — not assignable to `never` | ~8 | Add `as Agent[]` / `as Task[]` to empty array literals in seed objects |
| TS2339 — property does not exist on `unknown` | ~8 | Cast `JSON.parse()` result to correct type |
| TS2571 — object is `unknown` | ~4 | Cast `JSON.parse()` result to correct type |
| TS18046 — `x` is `unknown` | ~3 | Narrow with type assertion after parse |
| TS2345 — argument type mismatch | ~2 | Fix upstream type, or add cast |

**The single most impactful fix:** Add `let dir: string;` in the `beforeEach` blocks of `coordinator.test.ts` and `e2e/orchestrationLifecycle.e2e.test.ts`. This resolves ~150 of the 310 errors as cascades.

---

## Exact commands to run first

```bash
# 1. Go to the worktree
cd /Users/teemu/code/orc-state/.worktrees/test-ts-migration

# 2. See current full error list
npx tsc --noEmit 2>&1

# 3. See errors per file (quick overview)
npx tsc --noEmit 2>&1 | grep "error TS" | sed 's|([0-9]*,[0-9]*).*||' | sort | uniq -c | sort -rn

# 4. After fixing, verify
npx tsc --noEmit && npm test 2>&1 | tail -10
```

Work order: `coordinator.test.ts` first (most errors, clearest fixes), then `e2e/orchestrationLifecycle.e2e.test.ts`, then `mcp/handlers.test.ts`.

---

## Types available

All schema types are in `types/index.ts`. Import with:
```ts
import type { Agent, AgentsState, Task, Feature, Backlog, Claim, ClaimsState } from './types/index.ts';
// or from subdirectories:
import type { Agent, Backlog } from '../types/index.ts';
```

Do **not** use `as any`. Use `as unknown as T` only when truly necessary. Prefer typed `JSON.parse` casts (`JSON.parse(x) as AgentsState`) and explicit variable types.
