# Task 61 — Binary Check in `orc-worker-start-session`

Depends on Task 59 (binaryCheck utility). Independent of Tasks 60, 62, 63.

---

## Scope

**In scope:**
- `cli/start-worker-session.mjs` — add binary check after provider is resolved
- `cli/start-worker-session.test.mjs` — add tests

**Out of scope:**
- `lib/binaryCheck.mjs` — created in Task 59
- Coordinator-side failure handling — Task 63

---

## Context

`orc-worker-start-session` registers a worker and leaves `session_handle: null` so the coordinator picks it up and spawns the PTY on its next tick. If the required binary is not installed, the coordinator will fail silently when it tries to spawn the session.

This task adds an early check: after the provider is resolved (from flag or interactive prompt), call `checkAndInstallBinary(provider)` before touching `agents.json`. If the binary is unavailable and the user declines installation, exit 1 with an actionable message.

**Affected files:**
- `cli/start-worker-session.mjs`
- `cli/start-worker-session.test.mjs`

---

## Goals

1. `checkAndInstallBinary(provider)` is called after the provider is known and before agent registration.
2. If it returns `false`, exit 1.
3. If it returns `true` (binary present or just installed), proceed normally.
4. No other behaviour changes.

---

## Implementation

### Step 1 — Add import to `cli/start-worker-session.mjs`

```js
import { checkAndInstallBinary } from '../lib/binaryCheck.mjs';
```

### Step 2 — Add binary check after provider is resolved

Find the block where the provider is resolved and `worker` is set, just before the liveness check:

```js
// After this block:
if (provider && provider !== worker.provider) {
  console.error(`Provider mismatch...`);
  process.exit(1);
}

// Add immediately after:
const binaryOk = await checkAndInstallBinary(worker.provider);
if (!binaryOk) {
  console.error(`Cannot start worker session: '${worker.provider}' binary not available.`);
  process.exit(1);
}
```

That's the entire change — two lines plus the import.

---

## Acceptance criteria

- [ ] `orc-worker-start-session bob --provider=claude` checks for the `claude` binary before proceeding.
- [ ] If `claude` binary is missing and user declines: exits 1, `agents.json` is NOT modified (check fires before registration of a new worker — see note below).
- [ ] If binary is present: proceeds normally with no visible change in behaviour.
- [ ] `npm run test:orc:unit` passes.

**Note on registration order:** The current script registers the worker first (if missing), then resolves provider from the registered worker record. The binary check fires after the provider is known. This means for a *new* worker, registration happens before the binary check. If this ordering is undesirable (agent registered but session never starts), we could move registration after the binary check. Evaluate during implementation — the simplest fix is to move the binary check before `registerAgent()` by using the resolved `provider` variable.

---

## Tests

Add to `cli/start-worker-session.test.mjs`:

```js
describe('binary check', () => {
  it('exits 1 when binary unavailable and user declines', async () => { ... });
  it('proceeds normally when binary is available', async () => { ... });
});
```

Mock `checkAndInstallBinary` via `vi.doMock('../lib/binaryCheck.mjs', ...)`.

---

## Verification

```bash
nvm use 24 && npm run test:orc:unit

# Smoke (requires a binary that is NOT installed, e.g. 'codex' if not present):
ORCH_STATE_DIR=/tmp/orc-smoke \
  node cli/start-worker-session.mjs bob --provider=codex
# Expected: "Binary 'codex' is not installed..." prompt → y/n
```
