# Task 42 — Update Adapter Factory (`adapters/index.mjs`)

Depends on Tasks 40 and 41. Blocks Tasks 45, 46, 47.

---

## Scope

**In scope:**
- Rewrite `adapters/index.mjs` to wire all providers to `createTmuxAdapter`
- Remove all SDK-specific imports (`createClaudeAdapter`, `createCodexAdapter`, `createGeminiAdapter`)
- Keep `assertAdapterContract` export (used by tests and doctor)

**Out of scope:**
- `adapters/tmux.mjs` — created in Task 41
- `adapters/interface.mjs` — unchanged
- No other files

---

## Context

`adapters/index.mjs` currently imports from the three SDK adapter files (now deleted in Task 40)
and exports a `createAdapter(provider, options)` factory. After this task, the factory will
create a `TmuxAdapter` for every provider, passing the `provider` name so the adapter knows
which CLI binary to launch.

**Current `adapters/index.mjs` structure (to be replaced):**
```js
import { createCodexAdapter }  from './codex.mjs';
import { createClaudeAdapter } from './claude.mjs';
import { createGeminiAdapter } from './gemini.mjs';
import { assertAdapterContract } from './interface.mjs';

const FACTORIES = { codex: createCodexAdapter, claude: createClaudeAdapter, gemini: createGeminiAdapter };

export function createAdapter(provider, options = {}) {
  const factory = FACTORIES[provider];
  if (!factory) throw new Error(`Unknown provider: ${provider}`);
  const adapter = factory(options);
  assertAdapterContract(adapter);
  return adapter;
}

export { createCodexAdapter, createClaudeAdapter, createGeminiAdapter, assertAdapterContract };
```

**Affected files:**
- `adapters/index.mjs` — full rewrite

---

## Goals

1. Must export `createAdapter(provider, options)` with the same call signature as before
2. `createAdapter` must pass `provider` to `createTmuxAdapter` so it knows which binary to use
3. Must keep `assertAdapterContract` export (callers such as `doctor.mjs` and tests use it)
4. Must remove all references to deleted SDK adapter files
5. Must not change `adapters/interface.mjs`

---

## Implementation

### Step 1 — Rewrite `adapters/index.mjs`

Replace the entire file with:

```js
import { createTmuxAdapter }   from './tmux.mjs';
import { assertAdapterContract } from './interface.mjs';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'gemini']);

/**
 * Create an adapter for the given provider.
 * All providers use the tmux adapter — the provider name determines which
 * CLI binary is launched inside the tmux window.
 *
 * @param {'claude'|'codex'|'gemini'} provider
 * @param {object} [options]   Passed through to createTmuxAdapter.
 * @returns Adapter object satisfying the interface contract.
 */
export function createAdapter(provider, options = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider: ${provider}. Supported: ${[...SUPPORTED_PROVIDERS].join(', ')}`);
  }
  const adapter = createTmuxAdapter({ ...options, provider });
  assertAdapterContract(adapter);
  return adapter;
}

export { createTmuxAdapter, assertAdapterContract };
```

---

## Acceptance criteria

- [ ] `createAdapter('claude')` returns an adapter without throwing
- [ ] `createAdapter('codex')` returns an adapter without throwing
- [ ] `createAdapter('gemini')` returns an adapter without throwing
- [ ] `createAdapter('unknown')` throws with a descriptive message
- [ ] `assertAdapterContract` is exported and importable
- [ ] No import of `claude.mjs`, `codex.mjs`, or `gemini.mjs` remains in the file
- [ ] All orchestrator tests that import from `adapters/index.mjs` (e.g. coordinator tests) can still resolve the import

---

## Tests

No new tests needed for this file. Covered by Task 48 (tmux adapter tests) which exercises
`createAdapter` via the factory, and by the existing coordinator/worker tests that mock `adapters/index.mjs`.

---

## Verification

```bash
cd orchestrator && nvm use 22 && node -e "
  import('./adapters/index.mjs').then(m => {
    console.log(typeof m.createAdapter);       // 'function'
    console.log(typeof m.assertAdapterContract); // 'function'
    console.log(typeof m.createTmuxAdapter);   // 'function'
  });
"
```
