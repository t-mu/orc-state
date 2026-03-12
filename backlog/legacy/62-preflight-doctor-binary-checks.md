# Task 62 — Binary Checks in `orc-preflight` and `orc-doctor`

Depends on Task 59 (binaryCheck utility). Independent of Tasks 60, 61, 63.

---

## Scope

**In scope:**
- `cli/preflight.mjs` — add `provider_binaries` check
- `cli/doctor.mjs` — add binary availability to output
- Tests for the new check in both scripts

**Out of scope:**
- `lib/binaryCheck.mjs` — created in Task 59
- Any other CLI scripts

---

## Context

`orc-preflight` is the system readiness gate run before starting a session. `orc-doctor` is a diagnostic tool. Both should surface missing provider binaries early so the user knows what to install before the coordinator tries to spawn a session and fails.

### What to check

For each distinct `provider` value across all registered agents in `agents.json`, check whether the corresponding binary is available via `isBinaryAvailable(binary)`.

Example output for `orc-preflight`:

```
provider_binaries:
  claude: ✓ available
  codex:  ✗ missing  (install: npm install -g @openai/codex)
```

**Affected files:**
- `cli/preflight.mjs`
- `cli/doctor.mjs`

---

## Goals

1. `orc-preflight` exits 1 (with existing logic) when any registered agent's binary is missing.
2. `orc-preflight --json` includes a `provider_binaries` map `{ claude: true, codex: false, ... }` in the output.
3. `orc-doctor` prints binary availability for all providers of registered agents, with install hints for any missing ones.
4. `isBinaryAvailable` is called — no installation is triggered from preflight or doctor (read-only diagnostic).

---

## Implementation

### `cli/preflight.mjs`

Add import:
```js
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from '../lib/binaryCheck.mjs';
```

Add to checks computation:
```js
// Collect distinct providers across all registered agents
const requiredProviders = [...new Set(agents.map((a) => a.provider).filter(Boolean))];
const providerBinaries = Object.fromEntries(
  requiredProviders.map((p) => [p, isBinaryAvailable(PROVIDER_BINARIES[p] ?? p)])
);
const allBinariesPresent = Object.values(providerBinaries).every(Boolean);
```

Add `allBinariesPresent` to the `ok` condition:
```js
const ok = checks.state_valid
  && checks.has_registered_workers
  && checks.orphaned_active_claims.length === 0
  && allBinariesPresent;
```

Add to JSON output:
```js
checks: {
  ...checks,
  provider_binaries: providerBinaries,
  orphaned_active_claims_count: checks.orphaned_active_claims.length,
},
```

Add to text output:
```js
console.log('provider_binaries:');
for (const [provider, ok] of Object.entries(providerBinaries)) {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  const pkg    = PROVIDER_PACKAGES[provider] ?? '';
  if (ok) {
    console.log(`  ${provider}: ✓ available`);
  } else {
    console.log(`  ${provider}: ✗ missing  (install: npm install -g ${pkg})`);
  }
}
```

### `cli/doctor.mjs`

Read the doctor.mjs file first, then add a similar binary check section to its output. Binary status should appear near the top of doctor output (before orphaned claims, after state validation).

---

## Acceptance criteria

- [ ] `orc-preflight` exits 1 when any registered agent's provider binary is missing.
- [ ] `orc-preflight --json` includes `checks.provider_binaries` map.
- [ ] `orc-doctor` shows binary status for all registered agent providers.
- [ ] Missing binaries include the `npm install -g` hint in both text outputs.
- [ ] When no agents are registered, `provider_binaries` is `{}` and does not affect `ok`.
- [ ] `npm run test:orc:unit` passes.

---

## Tests

Add to `cli/preflight.test.mjs` (create if absent) and `cli/doctor.test.mjs` (create if absent):

```js
it('reports binary missing for registered agent provider', async () => { ... });
it('preflight exits 1 when binary missing', async () => { ... });
it('preflight ok when all binaries present', async () => { ... });
```

Mock `isBinaryAvailable` via `vi.doMock('../lib/binaryCheck.mjs', ...)`.

---

## Verification

```bash
nvm use 24
ORCH_STATE_DIR=/tmp/orc-smoke orc-preflight
# If codex is not installed and a codex worker is registered:
# Expected: provider_binaries: codex: ✗ missing (install: npm install -g @openai/codex)
# Expected: exit 1

ORCH_STATE_DIR=/tmp/orc-smoke orc-doctor
# Expected: binary status section in output
```
