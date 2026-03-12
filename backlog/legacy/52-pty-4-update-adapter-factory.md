# Task 52 — Update Adapter Factory (`adapters/index.mjs`)

Depends on Task 51 (pty.mjs created). Blocks Tasks 53, 54, 55.

---

## Scope

**In scope:**
- `adapters/index.mjs` — swap `createTmuxAdapter` for `createPtyAdapter`

**Out of scope:**
- `adapters/tmux.mjs` — deleted in Task 58; do not touch yet
- `adapters/pty.mjs` — already created in Task 51; do not modify
- All other files — do not touch

---

## Context

`adapters/index.mjs` is the single entry point through which the coordinator and all CLI scripts obtain an adapter. Currently it imports `createTmuxAdapter` from `./tmux.mjs` and forwards all providers to it. After this task it imports `createPtyAdapter` from `./pty.mjs` instead.

The `assertAdapterContract` export and the provider validation logic (`SUPPORTED_PROVIDERS`) remain unchanged. All callers (`coordinator.mjs`, `cli/start-session.mjs`, `cli/start-worker-session.mjs`, `cli/attach.mjs`, `cli/remove-worker.mjs`, `cli/kill-all.mjs`, `cli/clear-workers.mjs`) will automatically pick up the pty adapter through this single change.

The `tmuxSession` option that some callers pass to `createAdapter(provider, { tmuxSession: ... })` is no longer meaningful. The pty adapter's `createPtyAdapter` factory accepts a `provider` option but ignores unknown options — passing `tmuxSession` is harmless and will be cleaned up when tmux.mjs is deleted in Task 58.

**Affected files:**
- `adapters/index.mjs`

---

## Goals

1. Must replace the `import { createTmuxAdapter }` line with `import { createPtyAdapter }`.
2. Must call `createPtyAdapter({ ...options, provider })` instead of `createTmuxAdapter(...)`.
3. Must export `createPtyAdapter` instead of `createTmuxAdapter`.
4. Must preserve `assertAdapterContract`, `SUPPORTED_PROVIDERS`, and the unknown-provider error.
5. All existing callers that call `createAdapter(provider)` must continue to work without changes.

---

## Implementation

### Step 1 — Replace `adapters/index.mjs`

Full file after the change:

```js
import { createPtyAdapter }    from './pty.mjs';
import { assertAdapterContract } from './interface.mjs';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'gemini']);

/**
 * Create an adapter for the given provider.
 * All providers use the pty adapter; the provider selects which CLI binary to launch.
 *
 * @param {'claude'|'codex'|'gemini'} provider
 * @param {object} [options]
 * @returns {object}
 */
export function createAdapter(provider, options = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown provider: ${provider}. Supported: ${[...SUPPORTED_PROVIDERS].join(', ')}`,
    );
  }

  const adapter = createPtyAdapter({ ...options, provider });
  assertAdapterContract(adapter);
  return adapter;
}

export { createPtyAdapter, assertAdapterContract };
```

---

## Acceptance criteria

- [ ] `adapters/index.mjs` imports from `./pty.mjs`, not `./tmux.mjs`.
- [ ] `createAdapter('claude')` returns an object that passes `assertAdapterContract`.
- [ ] `createAdapter('unknown')` throws with "Unknown provider".
- [ ] `createPtyAdapter` is exported from the index (for test files that import it directly).
- [ ] `adapters/tmux.mjs` is not modified.

---

## Tests

Existing tests in `adapters/tmux.test.mjs` (the `adapter factory and contract` describe block) will need updates in Task 58 when tmux.mjs is deleted. At this task's boundary, those tests will temporarily fail because `tmux.test.mjs` still imports from `./tmux.mjs` directly. This is expected — do not fix it here.

The factory-level tests in `adapters/pty.test.mjs` (written in Task 57) cover this.

---

## Verification

```bash
nvm use 24
node --input-type=module <<'EOF'
import { createAdapter, assertAdapterContract } from './adapters/index.mjs';
const a = createAdapter('claude');
assertAdapterContract(a);
console.log('ok');
// Expected: ok
EOF

npm run test:orc:unit
# Expected: unit tests pass (tmux.test.mjs factory block will fail — acceptable at this step)
```
