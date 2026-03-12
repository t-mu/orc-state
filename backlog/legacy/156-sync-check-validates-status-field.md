---
ref: orch/task-156-sync-check-validates-status-field
epic: orch
status: todo
---

# Task 156 — Sync Check Validates Status Field Presence

Depends on Task 153. Blocks nothing directly.

## Scope

**In scope:**
- Extend `scripts/backlog_sync_check.mjs` to report any spec file that has a `ref:` field but is missing a `status:` field as an error.
- Add an `extractMissingStatusRefs(backlogDocsDir)` helper function to the module.
- Update `validateBacklogSync` to include the missing-status check in its return value and failure output.
- Update `formatBacklogSyncResult` to include missing-status errors in its output string.

**Out of scope:**
- Validating the *value* of `status:` (only check presence, not whether it is a valid string).
- Changes to `orchestrator/` source code.
- Changes to `AGENTS.md` or template files.
- Adding new npm scripts.

---

## Context

### Current state

`scripts/backlog_sync_check.mjs` validates only that every spec with a `ref:` is registered in `.orc-state/backlog.json`. After Task 153, specs also carry `status:` in their frontmatter, but the sync check does not enforce this field's presence. A worker or author could accidentally write a new spec with `ref:` but without `status:`, and the check would pass — leaving the coordinator's auto-rebuild (Task 155) unable to read that task's status correctly.

### Desired state

`npm run backlog:sync:check` exits 1 with a clear message whenever a spec file has `ref:` but is missing `status:`. This enforces the new contract going forward: every spec that participates in the backlog system must be self-describing enough for the coordinator to reconstruct its state.

### Start here

- `scripts/backlog_sync_check.mjs` — the file to extend; read in full before editing

**Affected files:**
- `scripts/backlog_sync_check.mjs` — extend with status-field validation

---

## Goals

1. Must add `extractMissingStatusRefs(backlogDocsDir)` that returns the list of spec files with `ref:` but without `status:`.
2. Must integrate the missing-status check into `validateBacklogSync`, adding a `missing_status` array to the return value.
3. Must set `ok: false` in the result if either `missing` (unregistered refs) or `missing_status` is non-empty.
4. Must include missing-status file names in the `formatBacklogSyncResult` output with a distinct label.
5. Must export the new helper so existing tests can import it directly.

---

## Implementation

### Step 1 — Add `extractMissingStatusRefs`

**File:** `scripts/backlog_sync_check.mjs`

Add after the existing `extractTaskSpecRefs` function:

```js
export function extractMissingStatusRefs(backlogDocsDir) {
  return readdirSync(backlogDocsDir)
    .filter((name) => /^\d+-.+\.md$/.test(name))
    .flatMap((name) => {
      const text = readFileSync(join(backlogDocsDir, name), 'utf8');
      const hasRef = /^ref:\s+.+$/m.test(text);
      const hasStatus = /^status:\s+.+$/m.test(text);
      if (!hasRef || hasStatus) return [];
      return [{ file: name }];
    });
}
```

### Step 2 — Update `validateBacklogSync`

**File:** `scripts/backlog_sync_check.mjs`

```js
export function validateBacklogSync(backlogDocsDir, stateBacklogPath) {
  const specs = extractTaskSpecRefs(backlogDocsDir);
  const registered = extractRegisteredTaskRefs(stateBacklogPath);
  const missing = specs.filter((spec) => !registered.has(spec.ref));
  const missing_status = extractMissingStatusRefs(backlogDocsDir);
  return {
    ok: missing.length === 0 && missing_status.length === 0,
    spec_count: specs.length,
    missing,
    missing_status,
  };
}
```

### Step 3 — Update `formatBacklogSyncResult`

**File:** `scripts/backlog_sync_check.mjs`

```js
export function formatBacklogSyncResult(result) {
  if (result.ok) {
    return `backlog sync OK: ${result.spec_count} specs matched orchestrator state`;
  }
  const lines = [];
  if (result.missing.length > 0) {
    lines.push(`backlog sync FAILED: ${result.missing.length} missing ref(s)`);
    lines.push(...result.missing.map((e) => `- ${e.ref} (${e.file})`));
  }
  if (result.missing_status.length > 0) {
    lines.push(`backlog sync FAILED: ${result.missing_status.length} spec(s) missing status: field`);
    lines.push(...result.missing_status.map((e) => `- (${e.file})`));
  }
  return lines.join('\n');
}
```

---

## Acceptance criteria

- [ ] `npm run backlog:sync:check` exits 1 when any spec with `ref:` is missing `status:`.
- [ ] The failure message names the specific file(s) missing the `status:` field.
- [ ] `npm run backlog:sync:check` continues to exit 0 when all specs with `ref:` have `status:`.
- [ ] `extractMissingStatusRefs` is exported and importable.
- [ ] Spec files without `ref:` are not affected by the status check.
- [ ] Existing `extractTaskSpecRefs` and `extractRegisteredTaskRefs` behaviour is unchanged.
- [ ] No changes to files outside `scripts/backlog_sync_check.mjs`.

---

## Tests

**File:** `scripts/backlog_sync_check.test.mjs` (create if it doesn't exist, or add to existing):

```js
it('extractMissingStatusRefs returns files with ref: but missing status:', () => { ... });
it('validateBacklogSync sets ok: false when a spec is missing status:', () => { ... });
it('formatBacklogSyncResult includes missing-status filenames in output', () => { ... });
it('validateBacklogSync sets ok: true when all ref-bearing specs have status:', () => { ... });
```

---

## Verification

```bash
# Smoke test: temporarily remove status: from one spec and check failure
sed -i '' '/^status:/d' docs/backlog/141-add-managed-worker-pool-config-and-slot-model.md
npm run backlog:sync:check
# Expected: exit 1, mentions 141-add-managed-worker-pool-config-and-slot-model.md
git restore docs/backlog/141-add-managed-worker-pool-config-and-slot-model.md
npm run backlog:sync:check
# Expected: exit 0
```

```bash
nvm use 24 && npm run build
nvm use 24 && npm test
```
