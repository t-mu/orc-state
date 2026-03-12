# Task 71 — Remove Stale `coordinator.pid` in `orc-kill-all`

Independent task. Can be done after Task 63.

## Scope

**In scope:**
- `cli/kill-all.mjs` — stale coordinator PID-file cleanup
- `cli/kill-all.test.mjs` — stale PID regression coverage

**Out of scope:**
- Coordinator lock acquisition logic in `coordinator.mjs`
- Agent session adapter internals

---

## Context

`orc-kill-all` checks and signals coordinator PID but does not remove stale `coordinator.pid` when process is already dead (`ESRCH`). This can leave misleading state for diagnostics and startup tooling.

**Affected files:**
- `cli/kill-all.mjs`
- `cli/kill-all.test.mjs`

---

## Goals

1. Must remove stale `coordinator.pid` when PID is not alive.
2. Must preserve current behavior when coordinator is live.
3. Must keep `--keep-sessions` semantics unchanged.
4. Must remain idempotent across repeated calls.

---

## Implementation

### Step 1 — Add stale-PID cleanup branch

**File:** `cli/kill-all.mjs`

- On `ESRCH` during liveness/signal checks, unlink `coordinator.pid`.
- Log explicit stale PID cleanup message.

### Step 2 — Add tests

**File:** `cli/kill-all.test.mjs`

- Seed stale `coordinator.pid`.
- Assert command removes file and exits successfully.

---

## Acceptance criteria

- [ ] Stale `coordinator.pid` is removed during `orc-kill-all`.
- [ ] Live coordinator path still signals and waits as before.
- [ ] Repeated `orc-kill-all` runs do not fail.

---

## Tests

Add to `cli/kill-all.test.mjs`:

```js
it('removes stale coordinator.pid when process is already dead', () => { ... });
```

---

## Verification

```bash
npx vitest run -c orchestrator/vitest.config.mjs cli/kill-all.test.mjs
```
