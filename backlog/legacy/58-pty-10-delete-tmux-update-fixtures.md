# Task 58 — Delete tmux Adapter and Update Test Fixtures

Depends on Tasks 52, 53, 54, 55, 56, 57. Final task in the pty migration.

---

## Scope

**In scope:**
- Delete `adapters/tmux.mjs`
- Delete `adapters/tmux.test.mjs`
- Update session handle strings in test fixtures: `tmux:orc:` / `tmux:orch:` → `pty:`
- Update `provider_ref` shapes in test fixtures to remove `tmux_session`
- Update error message string in `cli/clear-workers.test.mjs`
- Update description text in `schemas/agents.schema.json`
- Remove `ORCH_TMUX_SESSION` env var reference from any remaining files

**Out of scope:**
- `adapters/pty.mjs` — do not modify
- `adapters/index.mjs` — already updated in Task 52
- CLI scripts — already updated in Tasks 53, 54, 55
- Templates — already updated in Task 56
- Coordinator logic — no changes needed

---

## Context

This cleanup task removes all remaining tmux artefacts after the rest of the migration is complete. It must be the last task because it deletes `tmux.mjs`, which is still referenced by `tmux.test.mjs` (and any test that imports it directly).

### Files to delete

| File | Reason |
|---|---|
| `adapters/tmux.mjs` | Replaced by `pty.mjs` |
| `adapters/tmux.test.mjs` | Replaced by `pty.test.mjs` (Task 57) |

### Test fixture files to update

The following files contain `tmux:orc:` or `tmux:orch:` session handles that must become `pty:` handles:

| File | What changes |
|---|---|
| `e2e/orchestrationLifecycle.e2e.test.mjs` | 7 session handle strings |
| `lib/agentRegistry.test.mjs` | 3 lines: handle string + `provider_ref.tmux_session` field |
| `lib/dispatchPlanner.test.mjs` | 1 session handle string |

Additionally:

| File | What changes |
|---|---|
| `cli/clear-workers.test.mjs` | Error message string `'tmux unavailable'` → `'pty unavailable'` |
| `schemas/agents.schema.json` | Description string: remove "tmux pane" |

**Affected files:**
- `adapters/tmux.mjs` — deleted
- `adapters/tmux.test.mjs` — deleted
- `e2e/orchestrationLifecycle.e2e.test.mjs` — session handles
- `lib/agentRegistry.test.mjs` — session handle + provider_ref
- `lib/dispatchPlanner.test.mjs` — session handle
- `cli/clear-workers.test.mjs` — error message string
- `schemas/agents.schema.json` — description text

---

## Goals

1. Must delete both tmux adapter files.
2. Must update all `tmux:orc:` and `tmux:orch:` session handle strings in test fixtures.
3. Must update `provider_ref` in `agentRegistry.test.mjs` to remove `tmux_session` and match the pty adapter's shape `{ pid, provider, binary }`.
4. Must update the error message string in `clear-workers.test.mjs`.
5. Must update the schema description.
6. After all changes: `npm run test:orc:unit && npm run test:orc:e2e` must pass.
7. `grep -r "tmux" orchestrator/ --include="*.mjs" --include="*.json"` must return no matches (except this backlog file).

---

## Implementation

### Step 1 — Delete the tmux adapter files

```bash
rm adapters/tmux.mjs
rm adapters/tmux.test.mjs
```

### Step 2 — Update `e2e/orchestrationLifecycle.e2e.test.mjs`

There are 7 occurrences of `tmux:orc:` session handles. Replace all:

```js
// Find (all 7):
`tmux:orc:${agentId}`     →  `pty:${agentId}`
'tmux:orc:worker-01'      →  'pty:worker-01'
'tmux:orc:worker-02'      →  'pty:worker-02'
```

Also update the comment on line 22:
```js
// before:
* send() returns '' (fire-and-forget, matching the real tmux adapter).
// after:
* send() returns '' (fire-and-forget, matching the real pty adapter).
```

### Step 3 — Update `lib/agentRegistry.test.mjs`

Find the test that sets a session handle and provider_ref with tmux values (around lines 124–129):

```js
// before:
session_handle: 'tmux:orch:agent-01',
provider_ref:   { tmux_session: 'orch' },
// ...
expect(a.session_handle).toBe('tmux:orch:agent-01');
expect(a.provider_ref.tmux_session).toBe('orch');

// after:
session_handle: 'pty:agent-01',
provider_ref:   { pid: 99999, provider: 'claude', binary: 'claude' },
// ...
expect(a.session_handle).toBe('pty:agent-01');
expect(a.provider_ref.pid).toBe(99999);
```

### Step 4 — Update `lib/dispatchPlanner.test.mjs`

Find line 9:
```js
// before:
session_handle: 'tmux:orch:worker',

// after:
session_handle: 'pty:worker',
```

### Step 5 — Update `cli/clear-workers.test.mjs`

Find line 89:
```js
// before:
throw new Error('tmux unavailable');

// after:
throw new Error('pty unavailable');
```

### Step 6 — Update `schemas/agents.schema.json`

Find the `session_handle` field description. It currently reads something like:
```json
"description": "Local attach target (pty id, tmux pane, adapter-specific handle). Null when offline."
```

Update to:
```json
"description": "Local attach target (adapter-specific handle, e.g. pty:agent-id). Null when offline."
```

### Step 7 — Verify no remaining tmux references

```bash
grep -rn "tmux" orchestrator/ --include="*.mjs" --include="*.json"
```

Expected: zero matches (aside from this backlog file, which is in `docs/`).

---

## Acceptance criteria

- [ ] `adapters/tmux.mjs` does not exist.
- [ ] `adapters/tmux.test.mjs` does not exist.
- [ ] `grep -r "tmux" orchestrator/ --include="*.mjs"` returns no matches.
- [ ] `grep -r "tmux" orchestrator/ --include="*.json"` returns no matches.
- [ ] `npm run test:orc:unit` passes.
- [ ] `npm run test:orc:e2e` passes.
- [ ] No files outside the stated scope are modified.

---

## Tests

No new tests — this task updates existing fixture data to match the new handle format.

---

## Verification

```bash
nvm use 24

# Confirm deletions
ls adapters/
# Expected: index.mjs  interface.mjs  pty.mjs  pty.test.mjs

# Confirm no tmux references in source
grep -rn "tmux" orchestrator/ --include="*.mjs" --include="*.json"
# Expected: no output

# Full test suite
npm run test:orc:unit && npm run test:orc:e2e
# Expected: all tests pass

# Smoke
npm run orc:doctor
npm run orc:status
```

---

## Risk / Rollback

**Risk:** A test fixture was missed and references a dead `tmux:` handle format — the coordinator would mark the session as offline and recreate it (self-healing), but a test assertion against the old handle string would fail.

**Rollback:** `git checkout adapters/tmux.mjs adapters/tmux.test.mjs` to restore the deleted files if any previous task needs to be re-run first.
