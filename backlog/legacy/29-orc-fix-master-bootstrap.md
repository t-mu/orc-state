# Task 29 — Fix Master-Agent Bootstrap Template Selection

Critical correctness fix. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Remove the local `buildSessionBootstrap` function from `coordinator.mjs`
- Import and call `buildSessionBootstrap` from `lib/sessionBootstrap.mjs` (already exists, already correct)
- Update the `ensureSessionReady` call-site to pass `agent.role`
- Add a test covering master-role bootstrap selection

**Out of scope:**
- Changes to `lib/sessionBootstrap.mjs` (it is already correct)
- Changes to template files (`worker-bootstrap-v2.txt`, `master-bootstrap-v1.txt`)
- Changes to any other CLI or library file

---

## Context

`coordinator.mjs` defines a private `buildSessionBootstrap(agentId, provider)` function
at line 215 that ignores the `agent.role` field and always renders `worker-bootstrap-v2.txt`:

```js
function buildSessionBootstrap(agentId, provider) {
  return renderTemplate('worker-bootstrap-v2.txt', { agent_id: agentId, provider });
}
```

`lib/sessionBootstrap.mjs` already exists and does the correct thing — it selects the
template based on `role`:

```js
export function buildSessionBootstrap(agentId, provider, role) {
  const template = role === 'master' ? 'master-bootstrap-v1.txt' : 'worker-bootstrap-v2.txt';
  return renderTemplate(template, { agent_id: agentId, provider });
}
```

The coordinator never imports this module. As a result, any master-role agent whose session
is auto-started by the coordinator receives `WORKER_BOOTSTRAP v3` instructions instead of
`MASTER_BOOTSTRAP v1`, completely inverting its expected behaviour (worker instructions tell
the agent to wait for a TASK_START block and emit [ORC_EVENT] lines; master instructions tell
it to coordinate work and delegate tasks).

**Affected files:**
- `coordinator.mjs` — remove local function; import library version
- `e2e/orchestrationLifecycle.e2e.test.mjs` — add test for master bootstrap

---

## Goals

1. Must import `buildSessionBootstrap` from `./lib/sessionBootstrap.mjs` in `coordinator.mjs`
2. Must remove the local `buildSessionBootstrap` function definition from `coordinator.mjs`
3. Must pass `agent.role` as the third argument when calling `buildSessionBootstrap`
4. Must pass `renderTemplate` import removal check — `renderTemplate` may still be used elsewhere in coordinator; remove import only if no other calls remain
5. Must have a test that confirms a master-role agent receives bootstrap content containing `MASTER_BOOTSTRAP` and not `WORKER_BOOTSTRAP`
6. Must not change `lib/sessionBootstrap.mjs`, `adapters/`, or any template files

---

## Implementation

### Step 1 — Add import in `coordinator.mjs`

**File:** `coordinator.mjs`

Add to the import section (near the top, after existing imports):

```js
import { buildSessionBootstrap } from './lib/sessionBootstrap.mjs';
```

### Step 2 — Remove the local function

**File:** `coordinator.mjs`

Delete the entire local function (lines ~215–220):

```js
// DELETE this entire block:
function buildSessionBootstrap(agentId, provider) {
  return renderTemplate('worker-bootstrap-v2.txt', {
    agent_id: agentId,
    provider,
  });
}
```

### Step 3 — Update the call-site in `ensureSessionReady`

**File:** `coordinator.mjs`

In `ensureSessionReady(agent)`, update the `adapter.start` call to pass `agent.role`:

```js
// Before:
const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
  system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider),
});

// After:
const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
  system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider, agent.role),
});
```

### Step 4 — Check `renderTemplate` import

**File:** `coordinator.mjs`

Search for other uses of `renderTemplate` in the file. It is also used in `buildTaskEnvelope`.
Keep the import. If somehow no other usage exists, remove it — but as of the current codebase,
`buildTaskEnvelope` uses `renderTemplate` so the import must remain.

### Step 5 — Add test

**File:** `e2e/orchestrationLifecycle.e2e.test.mjs`

Add to the existing describe block:

```js
it('uses master-bootstrap template for master-role agents', async () => {
  const bootstrapCalls = [];
  const start = vi.fn().mockImplementation(async (_agentId, config) => {
    bootstrapCalls.push(config.system_prompt ?? '');
    return { session_handle: `claude:master-test`, provider_ref: {} };
  });
  const heartbeatProbe = vi.fn().mockResolvedValue(true);
  const send = vi.fn().mockResolvedValue('');
  vi.doMock('../adapters/index.mjs', () => ({
    createAdapter: () => ({ start, send, heartbeatProbe, stop: vi.fn(), attach: vi.fn() }),
  }));

  // Register a master-role agent (no session_handle — forces start() call)
  writeAgents([{
    agent_id: 'master-agent',
    provider: 'claude',
    role: 'master',
    status: 'idle',
    registered_at: new Date().toISOString(),
  }]);
  writeBacklog({ epics: [] });
  writeClaims([]);
  writeEvents('');

  const { tick } = await import('../coordinator.mjs');
  await tick();

  expect(start).toHaveBeenCalledOnce();
  const prompt = bootstrapCalls[0];
  expect(prompt).toContain('MASTER_BOOTSTRAP');
  expect(prompt).not.toContain('WORKER_BOOTSTRAP');
});
```

---

## Acceptance criteria

- [ ] `coordinator.mjs` imports `buildSessionBootstrap` from `./lib/sessionBootstrap.mjs`
- [ ] No local `buildSessionBootstrap` function exists in `coordinator.mjs`
- [ ] `ensureSessionReady` passes `agent.role` as third argument to `buildSessionBootstrap`
- [ ] A master-role agent whose session is started by the coordinator receives prompt text containing `MASTER_BOOTSTRAP` (not `WORKER_BOOTSTRAP`)
- [ ] A worker-role agent still receives prompt text containing `WORKER_BOOTSTRAP`
- [ ] All existing tests pass
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `e2e/orchestrationLifecycle.e2e.test.mjs`:

```js
it('uses master-bootstrap template for master-role agents', () => { ... });
it('uses worker-bootstrap template for worker-role agents', () => { ... });
```

Both tests confirm the `system_prompt` passed to `adapter.start()` contains the expected
template header string.

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

Confirm the new test passes and no regressions appear.

```bash
# Confirm the local function is gone
grep -n 'renderTemplate.*worker-bootstrap-v2' coordinator.mjs
# Expected: no output (coordinator no longer renders worker-bootstrap directly)

grep -n 'buildSessionBootstrap' coordinator.mjs
# Expected: import line + one call-site in ensureSessionReady only
```
