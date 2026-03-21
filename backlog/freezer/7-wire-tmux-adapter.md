---
ref: general/7-wire-tmux-adapter
feature: general
priority: high
status: todo
---

# Task 7 — Wire tmux Adapter in adapters/index.ts

Depends on Task 6. Blocks Tasks 8, 9, 10, 12.

## Scope

**In scope:**
- `adapters/index.ts`: swap import from `createPtyAdapter`/`./pty.ts` to `createTmuxAdapter`/`./tmux.ts`
- Update the factory call inside `createAdapter()` from `createPtyAdapter` to `createTmuxAdapter`
- Update the named re-export at the bottom of `adapters/index.ts`

**Out of scope:**
- Deleting `adapters/pty.ts` (Task 13)
- Any changes to `adapters/tmux.ts` (Task 6)
- CLI or coordinator changes (Tasks 8–10)
- Tests (Task 11)

---

## Context

`adapters/index.ts` is the sole factory consumers use (`coordinator.ts`, `cli/attach.ts`, `cli/control-worker.ts`). Once Task 6 lands, this one-file change makes the entire system use the tmux adapter without touching any consumer.

### Current state

```ts
import { createPtyAdapter } from './pty.ts';
// ...
const adapter = createPtyAdapter({ ...options, provider });
// ...
export { createPtyAdapter, assertAdapterContract };
```

### Desired state

```ts
import { createTmuxAdapter } from './tmux.ts';
// ...
const adapter = createTmuxAdapter({ ...options, provider });
// ...
export { createTmuxAdapter, assertAdapterContract };
```

### Start here

- `adapters/index.ts` — three lines change; read it first to confirm current shape
- `adapters/tmux.ts` — confirm `createTmuxAdapter` export name matches

**Affected files:**
- `adapters/index.ts` — swap import + factory call + re-export

---

## Goals

1. Must import `createTmuxAdapter` from `./tmux.ts`; no remaining import of `createPtyAdapter` or `./pty.ts`.
2. Must call `createTmuxAdapter({ ...options, provider })` inside `createAdapter()`.
3. Must re-export `createTmuxAdapter` (replacing the `createPtyAdapter` re-export).
4. Must `assertAdapterContract` still be re-exported unchanged.
5. Must `createAdapter('unknown')` still throw `Unknown provider` (validation logic unchanged).
6. Must all existing adapter contract tests pass (the factory tests in `adapters/pty.test.ts` will be replaced by Task 11, but no test must be newly broken by this change alone).

---

## Implementation

### Step 1 — Swap import

**File:** `adapters/index.ts`

```ts
// Before:
import { createPtyAdapter } from './pty.ts';

// After:
import { createTmuxAdapter } from './tmux.ts';
```

### Step 2 — Swap factory call

**File:** `adapters/index.ts`

```ts
// Before:
const adapter = createPtyAdapter({ ...options, provider });

// After:
const adapter = createTmuxAdapter({ ...options, provider });
```

### Step 3 — Swap re-export

**File:** `adapters/index.ts`

```ts
// Before:
export { createPtyAdapter, assertAdapterContract };

// After:
export { createTmuxAdapter, assertAdapterContract };
```

Invariant: do not change `SUPPORTED_PROVIDERS`, the `assertAdapterContract` import, or any validation logic.

---

## Acceptance criteria

- [ ] `adapters/index.ts` contains no reference to `createPtyAdapter` or `./pty.ts`.
- [ ] `createAdapter('claude')` returns an adapter whose `start()` invokes `tmux new-session` (confirmed by unit test in Task 11).
- [ ] `createAdapter('unknown')` still throws `Unknown provider`.
- [ ] `assertAdapterContract` is still exported from `adapters/index.ts`.
- [ ] `npm test` passes (existing tests must not newly break from this wiring change alone).
- [ ] No changes to files outside `adapters/index.ts`.

---

## Tests

No new tests for this task — it is a one-file swap. The factory contract tests in `adapters/tmux.test.ts` (Task 11) cover `createAdapter` end-to-end. Confirm existing test suite passes after the swap.

---

## Verification

```bash
# Confirm no pty import remains
grep -n "pty" adapters/index.ts  # should return nothing

# Confirm tmux import present
grep -n "tmux" adapters/index.ts  # should show createTmuxAdapter import

# Full suite
nvm use 24 && npm test
```
