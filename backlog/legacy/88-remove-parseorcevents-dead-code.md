# Task 88 — Remove `parseOrcEvents` and `promptExistingMasterConflict` Dead Code

Independent. Can run in parallel with Tasks 85–87.

## Scope

**In scope:**
- `lib/responseParser.mjs` — delete file
- `lib/responseParser.test.mjs` — delete file
- `index.mjs` — remove `parseOrcEvents` export and header comment reference
- `orchestrator/index.test.mjs` — remove `parseOrcEvents` from API surface assertions
- `lib/prompts.mjs` — remove `promptExistingMasterConflict` function

**Out of scope:**
- `orchestrator/contracts.md` — [ORC_EVENT] references cleaned up by Task 74
- `orchestrator/README.md` — `parseOrcEvents` import example cleaned up by Task 79
- Any adapter, coordinator, or CLI logic changes

---

## Context

### `parseOrcEvents` — orphaned response parser

`lib/responseParser.mjs` defines `parseOrcEvents(responseText)`, which parses `[ORC_EVENT]`
JSON blocks from adapter response text. It is exported as a first-class public API in
`index.mjs` and has a full test suite.

However, **`coordinator.mjs` no longer calls it**. The [ORC_EVENT] response-parsing model
was retired when workers moved to calling `orc-run-start/finish/fail/heartbeat` CLI commands
directly (Tasks 43–45). The coordinator's `adapter.send()` now returns `''` (fire-and-forget)
and reads state exclusively from the event log — never from parsed response text.

Keeping `parseOrcEvents` in the public API:
1. Misleads implementers (and `contracts.md`) into thinking the response-parsing model is active
2. Causes `index.test.mjs` to list it as a required export — blocking the API surface cleanup
3. Maintains test coverage for dead code that diverges from the actual coordination protocol

### `promptExistingMasterConflict` — unreachable function

`lib/prompts.mjs` exports `promptExistingMasterConflict(existingMaster, coordinatorPid)`.
It is never imported or called anywhere in the codebase.
`start-session.mjs` uses `promptMasterAction()` for the same scenario.

**Affected files:**
- `lib/responseParser.mjs` — delete
- `lib/responseParser.test.mjs` — delete
- `index.mjs` — remove export (line 15) + header reference (line 6)
- `orchestrator/index.test.mjs` — remove `parseOrcEvents` from both test assertions
- `lib/prompts.mjs` — remove `promptExistingMasterConflict` function (lines 83–115)
  and its JSDoc comment (lines 77–82)

---

## Goals

1. `parseOrcEvents` must not be exported from `index.mjs` after this task.
2. `lib/responseParser.mjs` and its test file must not exist after this task.
3. `promptExistingMasterConflict` must not be exported from `lib/prompts.mjs`.
4. All remaining exports in `index.mjs` must continue to work; `index.test.mjs` must pass.
5. All other `prompts.mjs` functions must be unchanged and their tests must pass.

---

## Implementation

### Step 1 — Delete `responseParser.mjs` and its test file

Delete both files:
- `lib/responseParser.mjs`
- `lib/responseParser.test.mjs`

No other file imports `responseParser.mjs` except `index.mjs`.

Verify with:
```bash
grep -r 'responseParser' orchestrator/ --include='*.mjs' --include='*.ts'
# Should show only index.mjs (handled in Step 2) — nothing else
```

---

### Step 2 — Remove `parseOrcEvents` from `index.mjs`

**File:** `index.mjs`

Remove line 15:
```js
export { parseOrcEvents } from './lib/responseParser.mjs';
```

Update the JSDoc header to remove the `parseOrcEvents` line (line 6):
```js
// Before:
 *   createAdapter, assertAdapterContract  — provider adapter factory + contract check
 *   parseOrcEvents                        — [ORC_EVENT] response parser
 *   validateBacklog/Agents/Claims/StateDir — JSON state validators

// After:
 *   createAdapter, assertAdapterContract  — provider adapter factory + contract check
 *   validateBacklog/Agents/Claims/StateDir — JSON state validators
```

---

### Step 3 — Update `index.test.mjs`

**File:** `orchestrator/index.test.mjs`

Remove `'parseOrcEvents'` from the sorted keys array (line 9) and the callable check (line 21):

```js
// Before:
expect(Object.keys(orchestratorApi).sort()).toEqual([
  'assertAdapterContract',
  'createAdapter',
  'parseOrcEvents',
  'validateAgents',
  ...
]);

// After:
expect(Object.keys(orchestratorApi).sort()).toEqual([
  'assertAdapterContract',
  'createAdapter',
  'validateAgents',
  ...
]);
```

Also remove:
```js
// Before:
expect(typeof orchestratorApi.parseOrcEvents).toBe('function');

// After: (line deleted)
```

---

### Step 4 — Remove `promptExistingMasterConflict` from `prompts.mjs`

**File:** `lib/prompts.mjs`

Remove the JSDoc comment block (lines 77–82) and the `promptExistingMasterConflict`
function body (lines 83–115) entirely.

The removed block looks like:
```js
/**
 * @param {{ agent_id: string, provider: string }} existingMaster
 * @param {number|null} coordinatorPid  - null when coordinator is not running
 */
export async function promptExistingMasterConflict(existingMaster, coordinatorPid) {
  // ... 30 lines ...
}
```

No callers exist — confirmed by grep:
```bash
grep -r 'promptExistingMasterConflict' orchestrator/ --include='*.mjs'
# Should only show the definition in prompts.mjs; no callers
```

---

## Acceptance criteria

- [ ] `lib/responseParser.mjs` does not exist after this task.
- [ ] `lib/responseParser.test.mjs` does not exist after this task.
- [ ] `import { parseOrcEvents } from '@t-mu/orc-state'` throws `SyntaxError`
  (export removed) or `Module not found`.
- [ ] `index.test.mjs` passes without `parseOrcEvents` in the exports list.
- [ ] `import { promptExistingMasterConflict } from './lib/prompts.mjs'` resolves to `undefined`
  (named export removed).
- [ ] All other `prompts.mjs` exports (`promptCoordinatorAction`, `promptMasterAction`, etc.)
  are unchanged and all existing prompt tests pass.
- [ ] Full test suite passes: `cd orchestrator && npm test`.

---

## Tests

No new tests needed — the change is a deletion. The existing `index.test.mjs` will
fail until Step 3 is complete (removing `parseOrcEvents` from the expected exports list).

```bash
npx vitest run -c orchestrator/vitest.config.mjs orchestrator/index.test.mjs
npx vitest run -c orchestrator/vitest.config.mjs lib/prompts.test.mjs
```

---

## Verification

```bash
cd orchestrator && npm test
# Expected: all tests pass, no import errors
```

```bash
grep -r 'parseOrcEvents\|responseParser\|promptExistingMasterConflict' orchestrator/ --include='*.mjs'
# Expected: no matches (or only comments in contracts.md/README.md — handled by Tasks 74/79)
```

---

## Risk / Rollback

**Risk:** If any external code outside the `orchestrator/` directory imports `parseOrcEvents`,
removing it will cause a runtime import error. Verify with the grep above before deleting.

**Rollback:** `git restore index.mjs lib/responseParser.mjs
lib/responseParser.test.mjs lib/prompts.mjs orchestrator/index.test.mjs`
