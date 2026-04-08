---
ref: general/148-init-max-workers-default
feature: general
priority: high
status: todo
---

# Task 148 — Set max_workers: 1 in orc init Generated Config

Independent.

## Scope

**In scope:**
- Update `cli/init.ts` to always write `worker_pool.max_workers: 1` in the generated `orchestrator.config.json`
- Update `cli/init.test.ts` for both single-provider and multi-provider assertions
- Update `docs/configuration.md` to document the behavior

**Out of scope:**
- Changing the runtime default in `lib/providers.ts` (stays at 0)
- Modifying coordinator dispatch logic
- Changing the `orc start-session` startup flow

---

## Context

When a consumer runs `orc init` and then `orc start-session`, the coordinator
dispatches no work because `worker_pool.max_workers` defaults to `0` in the
runtime config (`lib/providers.ts`). There is no error or warning — the system
silently does nothing. This is the #1 new-user footgun.

The fix is scoped: `orc init` will write `max_workers: 1` inside the
`worker_pool` section of the generated `orchestrator.config.json`. The runtime
default in `lib/providers.ts` stays at `0` so programmatic/headless consumers
are not affected.

Current config generation in `cli/init.ts` lines 134-142:

```typescript
const config: Record<string, unknown> = {};
if (providers.length === 1) {
  config.default_provider = providers[0];
} else if (providers.length > 1) {
  config.default_provider = providers[0];
  config.worker_pool = { provider: providers[1] };
}
writeFileSync('orchestrator.config.json', JSON.stringify(config, null, 2) + '\n', 'utf8');
```

The multi-provider test at `cli/init.test.ts` line ~117 asserts `worker_pool`
equals `{ provider: 'codex' }` — this must be updated to include `max_workers: 1`.

**Affected files:**
- `cli/init.ts` — config generation (lines 134-142)
- `cli/init.test.ts` — single-provider and multi-provider config assertions
- `docs/configuration.md` — document default behavior

---

## Goals

1. Must write `worker_pool: { max_workers: 1 }` for single-provider init.
2. Must write `worker_pool: { provider: "...", max_workers: 1 }` for multi-provider init.
3. Must NOT change the runtime default in `lib/providers.ts` (stays at 0).
4. Must update docs to note "default 0, but `orc init` sets 1".
5. Must update all affected tests.

---

## Implementation

### Step 1 — Update config generation in cli/init.ts

**File:** `cli/init.ts`

Replace the config generation block (lines 134-142) with:

```typescript
// Step 3: Write orchestrator.config.json
const config: Record<string, unknown> = {};
if (providers.length === 1) {
  config.default_provider = providers[0];
} else if (providers.length > 1) {
  config.default_provider = providers[0];
  config.worker_pool = { provider: providers[1] };
}
// Always ensure worker_pool.max_workers is set so fresh installs dispatch work
config.worker_pool = { ...(config.worker_pool as object ?? {}), max_workers: 1 };
writeFileSync('orchestrator.config.json', JSON.stringify(config, null, 2) + '\n', 'utf8');
```

### Step 2 — Update tests

**File:** `cli/init.test.ts`

Update single-provider test assertion to expect:
```json
{ "default_provider": "claude", "worker_pool": { "max_workers": 1 } }
```

Update multi-provider test assertion (line ~117) from:
```json
{ "default_provider": "claude", "worker_pool": { "provider": "codex" } }
```
to:
```json
{ "default_provider": "claude", "worker_pool": { "provider": "codex", "max_workers": 1 } }
```

### Step 3 — Update documentation

**File:** `docs/configuration.md`

In the `worker_pool` configuration table, update the `max_workers` row default
description to note: "Default: `0`. `orc init` generates a config with
`max_workers: 1` for immediate usability."

---

## Acceptance criteria

- [ ] `orc init --provider=claude` generates config with `worker_pool: { max_workers: 1 }`.
- [ ] `orc init --provider=claude,codex` generates config with `worker_pool: { provider: "codex", max_workers: 1 }`.
- [ ] Runtime default in `lib/providers.ts` remains `0`.
- [ ] `docs/configuration.md` documents the `orc init` override behavior.
- [ ] `cli/init.test.ts` passes with updated assertions for both cases.
- [ ] `npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

Update existing tests in `cli/init.test.ts`:

```typescript
it('generates config with max_workers: 1 for single provider', () => { ... });
it('generates config with max_workers: 1 for multi provider', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
orc doctor
```
