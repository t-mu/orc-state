---
ref: general/13-remove-node-pty
feature: general
priority: normal
status: blocked
---

# Task 13 — Remove node-pty Dependency and pty Adapter Files

Depends on Tasks 8, 9, 10, 11, 12. Blocks nothing.

## Scope

**In scope:**
- Verify `node-pty` has zero remaining consumers; `npm uninstall node-pty`
- Delete `adapters/pty.ts`
- Delete `adapters/pty.test.ts`
- Delete `adapters/pty.integration.test.ts`
- Delete `.orc-state/pty-pids/` and `.orc-state/pty-logs/` directories if they exist (stale artifacts)
- Update `package.json` `prepare` script: remove the `chmod +x node_modules/node-pty/...` no-op line

**Out of scope:**
- Any functional changes — all prior tasks (6–12) must be complete before this task starts
- Changes to `adapters/index.ts` (done in Task 7)
- Changes to coordinator or CLI files (done in Tasks 8–10)
- Changing any state schemas or event formats

---

## Context

After Tasks 6–12 land, `node-pty` is imported only by `adapters/pty.ts`, which is no longer wired into `adapters/index.ts`. The pty adapter files and the `node-pty` npm package are dead code. This task performs the final cleanup.

**Before removing `node-pty`**, confirm that `masterPtyForwarder.ts` does not receive a node-pty instance from the coordinator. The forwarder's `masterPty: PtyLike | null | undefined` and `ptyDataEmitter: DataEmitter | null | undefined` parameters already support null — if the coordinator passes null when the master runs in the foreground terminal (not via the worker adapter), node-pty has zero consumers.

### Current state

- `node-pty@1.1.0` is in `package.json` dependencies
- `adapters/pty.ts`, `adapters/pty.test.ts`, `adapters/pty.integration.test.ts` exist
- `package.json` `prepare` script contains `chmod +x node_modules/node-pty/prebuilds/...`
- `adapters/index.ts` imports from `./tmux.ts` (Task 7 done)

### Desired state

- `node-pty` absent from `package.json` and `node_modules`
- `adapters/pty.ts`, `adapters/pty.test.ts`, `adapters/pty.integration.test.ts` deleted
- `package.json` `prepare` script has no node-pty reference
- `npm test` passes with zero node-pty references in the codebase

### Start here

- `coordinator.ts` — search for any `node-pty` import or masterPty initialisation to confirm it is null-safe
- `lib/masterPtyForwarder.ts` — confirm `masterPty` and `ptyDataEmitter` are null/undefined-safe (they already accept null)
- `package.json` — `dependencies` and `prepare` script

**Affected files:**
- `package.json` — remove `node-pty` from dependencies, update `prepare` script
- `adapters/pty.ts` — deleted
- `adapters/pty.test.ts` — deleted
- `adapters/pty.integration.test.ts` — deleted
- `.orc-state/pty-pids/` — deleted if present
- `.orc-state/pty-logs/` — deleted if present

---

## Goals

1. Must confirm zero remaining `import ... from 'node-pty'` or `require('node-pty')` in the codebase before uninstalling.
2. Must uninstall `node-pty` via `npm uninstall node-pty` (updates both `package.json` and `package-lock.json`).
3. Must delete the three pty adapter files.
4. Must remove the node-pty `chmod` line from the `prepare` script in `package.json`.
5. Must `npm test` pass after all deletions.
6. Must `orc doctor` exit 0 after all changes.

---

## Implementation

### Step 1 — Verify zero consumers

**Check:**

```bash
grep -rn "node-pty" --include="*.ts" .
```

Expected output: only `adapters/pty.ts` (and possibly `adapters/pty.test.ts`, `adapters/pty.integration.test.ts`). If any other file imports `node-pty`, stop and investigate before proceeding.

### Step 2 — Verify masterPtyForwarder is null-safe

**File:** `coordinator.ts`

Search for the call site of `startMasterPtyForwarder`. Confirm the `masterPty` and `ptyDataEmitter` arguments are either null or come from a node-pty instance. If they come from a node-pty instance, this task cannot land until the master session is also migrated (out of scope — raise as a blocker). If they are null or the master runs in the foreground terminal without PTY wrapping, proceed.

### Step 3 — Uninstall node-pty

```bash
npm uninstall node-pty
```

This removes the entry from `package.json` `dependencies` and `package-lock.json`.

### Step 4 — Delete pty adapter files

```bash
git rm adapters/pty.ts adapters/pty.test.ts adapters/pty.integration.test.ts
```

### Step 5 — Remove node-pty chmod from prepare script

**File:** `package.json`

Remove only the `chmod +x node_modules/node-pty/...` portion from the `prepare` script. Preserve the `simple-git-hooks` call and any other commands in the script.

```json
// Before:
"prepare": "simple-git-hooks && chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true"

// After:
"prepare": "simple-git-hooks"
```

### Step 6 — Clean up stale state artifacts

```bash
rm -rf .orc-state/pty-pids .orc-state/pty-logs
```

These directories contain PID files and log files from node-pty sessions. They are no longer written by the tmux adapter.

---

## Acceptance criteria

- [ ] `grep -rn "node-pty" --include="*.ts" .` returns no results.
- [ ] `node-pty` is absent from `package.json` `dependencies`.
- [ ] `adapters/pty.ts`, `adapters/pty.test.ts`, `adapters/pty.integration.test.ts` are deleted.
- [ ] `package.json` `prepare` script contains no node-pty reference.
- [ ] `npm test` passes with all tmux adapter tests green.
- [ ] `orc doctor` exits 0.
- [ ] No functional changes — only deletion and uninstall.
- [ ] No changes to files outside the stated scope.

## Risk / Rollback

**Risk:** If `coordinator.ts` or any other file passes a real node-pty instance to `startMasterPtyForwarder`, removing `node-pty` will break the master session at runtime even though tests pass (tests mock the PTY). Verify Step 2 carefully.

**Rollback:** `git restore package.json adapters/ && git checkout HEAD -- adapters/pty.ts adapters/pty.test.ts adapters/pty.integration.test.ts && npm install && npm test`

---

## Tests

No new tests. Verify all existing tests (including Task 11's `adapters/tmux.test.ts`) pass after deletion.

---

## Verification

```bash
# Confirm no node-pty references remain
grep -rn "node-pty" --include="*.ts" .     # expect: no output
grep -rn "node-pty" package.json            # expect: no output

# Confirm pty files deleted
ls adapters/pty*.ts 2>&1                   # expect: no such file

# Doctor
node --experimental-strip-types cli/doctor.ts

# Full suite
nvm use 24 && npm test
```
