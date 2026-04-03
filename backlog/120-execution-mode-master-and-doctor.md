---
ref: general/120-execution-mode-master-and-doctor
feature: general
priority: normal
status: done
depends_on:
  - general/117-execution-mode-config-types
---

# Task 120 — Execution Mode for Master Session and Doctor Check

Depends on Task 117 (config types and loader). Independent of Tasks 118-119 (can run in parallel).

## Scope

**In scope:**
- Update Codex master spawn args in `cli/start-session.ts` to branch on execution mode
- Add sandbox dependency check to `cli/doctor.ts` (bubblewrap + socat on Linux for Claude sandbox)
- Tests for both changes

**Out of scope:**
- Claude master session — currently interactive with no bypass flags, execution_mode is a no-op for Claude master
- Gemini master session — no flags in either mode
- Adapter changes (`adapters/pty.ts` — done in Task 118)
- Worker runtime / coordinator threading (Task 119)
- Documentation (Task 121)

---

## Context

### Current state

**Master session** (`cli/start-session.ts` lines 300-334): Spawn args are hand-rolled per provider in a separate code path from the adapter's `buildStartArgs()`. Codex master hardcodes `--dangerously-bypass-approvals-and-sandbox` at line 316. Claude master uses `--mcp-config` + `--system-prompt` + `--name MASTER` with no bypass flags. Gemini uses `--mcp-config` + `--system-instruction`.

**Doctor** (`cli/doctor.ts`): Runs health checks on state files and provider binaries. No sandbox dependency checks exist.

### Desired state

Codex master branches on `masterConfig.execution_mode`:
- `full-access`: `--dangerously-bypass-approvals-and-sandbox` (current)
- `sandbox`: `--sandbox workspace-write --ask-for-approval never`

Doctor checks for `bwrap` and `socat` on Linux when Claude provider is configured with sandbox mode.

### Start here

- `cli/start-session.ts` — lines 300-334 where master spawn args are built
- `cli/doctor.ts` — existing health check structure
- `lib/providers.ts` — `loadMasterConfig()` and `loadWorkerPoolConfig()` (from Task 117)

**Affected files:**
- `cli/start-session.ts` — Codex master spawn arg branching
- `cli/doctor.ts` — new sandbox dependency check
- `cli/doctor.test.ts` — new tests for sandbox dependency check

---

## Goals

1. Must branch Codex master spawn args on `masterConfig.execution_mode`.
2. Must preserve current behavior when `execution_mode` is `'full-access'` or absent.
3. Must add doctor check: when Claude is configured with sandbox mode, verify `bwrap` and `socat` on Linux.
4. Must scope sandbox dependency check to Claude provider only (Codex sandbox does not use bwrap/socat).
5. Must skip sandbox dependency check on macOS (Seatbelt is built-in).

---

## Implementation

### Step 1 — Codex master execution mode branching

**File:** `cli/start-session.ts`

In the `master.provider === 'codex'` branch (around line 314-321):

```ts
} else if (master.provider === 'codex') {
  const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
  const codexModeArgs = masterConfig.execution_mode === 'sandbox'
    ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
    : ['--dangerously-bypass-approvals-and-sandbox'];
  spawnArgs = [...codexModeArgs, ...masterModelArgs, bootstrap];
```

**⚠️ Implementation note:** Verify Codex flags against actual `codex --help`. If flag names differ, adjust and document.

### Step 2 — Doctor sandbox dependency check

**File:** `cli/doctor.ts`

Add a new check function that:
1. Loads `masterConfig` and `workerPoolConfig`
2. Checks if any Claude-provider role has `execution_mode === 'sandbox'`
3. If yes and `process.platform === 'linux'`:
   - Check `bwrap` is on PATH: `which bwrap`
   - Check `socat` is on PATH: `which socat`
   - Report missing dependencies with install hints:
     - Ubuntu/Debian: `sudo apt-get install bubblewrap socat`
     - Fedora: `sudo dnf install bubblewrap socat`
4. If macOS or no Claude sandbox configured: skip with pass status

---

## Acceptance criteria

- [ ] Codex master in full-access mode: spawns with `--dangerously-bypass-approvals-and-sandbox`.
- [ ] Codex master in sandbox mode: spawns with `--sandbox workspace-write --ask-for-approval never`.
- [ ] Claude master: no change in either mode (no bypass flags used).
- [ ] Gemini master: no change in either mode.
- [ ] Doctor reports missing bwrap/socat on Linux when Claude sandbox is configured.
- [ ] Doctor skips sandbox check on macOS.
- [ ] Doctor skips sandbox check when no Claude sandbox is configured.
- [ ] Doctor skips sandbox check for Codex sandbox (Codex doesn't use bwrap).
- [ ] No changes to files outside the stated scope.

---

## Tests

Add tests for the doctor check:

```ts
describe('doctor sandbox dependencies', () => {
  it('checks for bwrap and socat on linux with claude sandbox', () => { ... });
  it('skips check on macOS', () => { ... });
  it('skips check when no sandbox configured', () => { ... });
  it('skips check for codex sandbox', () => { ... });
});
```

---

## Verification

```bash
npx vitest run cli/doctor
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: exits 0 (or reports sandbox deps if claude sandbox configured on linux)
```

---

## Risk / Rollback

**Risk:** Low — Codex master flag change only affects Codex users who set sandbox mode. Doctor check is additive.
**Risk:** Codex flags need verification against actual CLI.
**Rollback:** Revert the commit.
