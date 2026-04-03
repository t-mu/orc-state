---
ref: general/118-execution-mode-adapter-flags
feature: general
priority: normal
status: todo
depends_on:
  - general/117-execution-mode-config-types
---

# Task 118 — Adapter Flag Mapping and Settings for Execution Modes

Depends on Task 117 (config types and loader). Blocks Task 119.

## Scope

**In scope:**
- Extend `Adapter.start()` options type with `execution_mode` field
- Update `buildStartArgs()` in `adapters/pty.ts` to branch on execution mode per provider
- Update Claude settings file generation to include sandbox config in sandbox mode
- Wire `read_only` into adapter flag/settings generation (currently a dead field)
- Guard the Claude auto-accept bypass dance on execution mode
- Update existing tests and add new tests for all mode × provider combinations

**Out of scope:**
- Config loading changes (`lib/providers.ts` — done in Task 117)
- Coordinator or worker runtime threading (`coordinator.ts`, `lib/workerRuntime.ts`)
- Master session spawn args (`cli/start-session.ts`)
- Doctor/preflight checks
- Documentation

---

## Context

### Current state

`buildStartArgs()` in `adapters/pty.ts` hardcodes permission flags per provider:
- Claude: always `--dangerously-skip-permissions` + hook-only settings file
- Codex: always `--dangerously-bypass-approvals-and-sandbox`
- Gemini: no flags

The `start()` method always runs the Claude auto-accept dance (writes `'2'` + `'\r'` to dismiss the bypass confirmation dialog) regardless of mode.

The `read_only` field is passed through to `adapter.start()` config but never consumed by `buildStartArgs` — it is a dead field.

### Desired state

`buildStartArgs()` branches on `execution_mode`:

| Provider | `full-access` | `sandbox` |
|----------|---------------|-----------|
| Claude | `--dangerously-skip-permissions` (current) | `--permission-mode auto` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` (current) | `--sandbox workspace-write --ask-for-approval never` |
| Gemini | no flags (current) | no flags (current) |

Claude settings file in sandbox mode merges the notification hook with sandbox configuration. The auto-accept dance only fires for `full-access` mode.

`read_only` is consumed: when true (scouts), Claude sandbox omits `allowWrite` from settings; Codex sandbox uses `--sandbox read-only` instead of `workspace-write`.

### Start here

- `adapters/pty.ts` — `buildStartArgs()` function and `start()` method
- `adapters/pty.test.ts` — existing flag assertion tests
- `lib/workerRuntime.ts` lines 111-118 — `Adapter` interface definition

**Affected files:**
- `adapters/pty.ts` — `buildStartArgs()`, settings file generation, auto-accept guard
- `adapters/pty.test.ts` — updated and new tests
- `lib/workerRuntime.ts` — `Adapter.start()` options type (add `execution_mode` field)

---

## Goals

1. Must extend the `Adapter.start()` options type in `lib/workerRuntime.ts` to include `execution_mode?: string`.
2. Must update `buildStartArgs()` to produce correct flags for each provider × execution mode combination.
3. Must update Claude settings file generation: sandbox mode merges notification hook + sandbox config block; full-access mode keeps hook-only (current behavior).
4. Must guard the Claude auto-accept bypass dance: only fire when `execution_mode === 'full-access'`.
5. Must wire `read_only` into flag/settings generation: Claude scouts get no `allowWrite`; Codex scouts get `--sandbox read-only`.
6. Must not break existing tests — update them to pass `execution_mode: 'full-access'` where needed.
7. Must default to `'full-access'` behavior when `execution_mode` is not provided (backward compatible).

---

## Implementation

### Step 1 — Extend Adapter interface

**File:** `lib/workerRuntime.ts` (lines 111-118)

Add `execution_mode?: string` to the `Adapter.start()` options type alongside the existing `read_only`, `model`, `system_prompt`, etc.

### Step 2 — Update buildStartArgs for Claude

**File:** `adapters/pty.ts`

In the Claude branch of `buildStartArgs()`:
- `full-access` (or undefined/missing): `['--dangerously-skip-permissions', '--settings', claudeSettingsPath]` (current behavior)
- `sandbox`: `['--permission-mode', 'auto', '--settings', claudeSettingsPath]`

### Step 3 — Update buildStartArgs for Codex

**File:** `adapters/pty.ts`

In the Codex branch of `buildStartArgs()`:
- `full-access` (or undefined): `['--dangerously-bypass-approvals-and-sandbox']` (current behavior)
- `sandbox` + NOT read_only: `['--sandbox', 'workspace-write', '--ask-for-approval', 'never']`
- `sandbox` + read_only (scouts): `['--sandbox', 'read-only', '--ask-for-approval', 'never']`

**⚠️ Implementation note:** Verify Codex flags (`--sandbox workspace-write --ask-for-approval never`) against actual `codex --help` during implementation. If flag names differ, adjust mapping and document the correct flags in a code comment.

### Step 4 — Update Claude settings file generation

**File:** `adapters/pty.ts` (in `start()` method, lines 238-249)

The settings JSON written to `pty-settings/{agentId}.json`:

**full-access mode** (current behavior):
```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "..." }] }]
  }
}
```

**sandbox mode** (worker, not read_only):
```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "..." }] }]
  },
  "sandbox": {
    "enabled": true,
    "mode": "auto-allow",
    "filesystem": { "allowWrite": ["."] },
    "allowUnsandboxedCommands": false
  }
}
```

**sandbox mode + read_only** (scouts):
```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "..." }] }]
  },
  "sandbox": {
    "enabled": true,
    "mode": "auto-allow",
    "allowUnsandboxedCommands": false
  }
}
```
Note: no `filesystem.allowWrite` — defaults to read-only writes (can only read, not write anywhere outside sandbox defaults).

### Step 5 — Guard auto-accept dance

**File:** `adapters/pty.ts` (in `start()` method, around line 293)

Change from:
```ts
if (provider === 'claude') {
  // write '2' + '\r' to dismiss bypass confirmation
}
```

To:
```ts
if (provider === 'claude' && executionMode !== 'sandbox') {
  // write '2' + '\r' to dismiss bypass confirmation
}
```

Using `!== 'sandbox'` rather than `=== 'full-access'` so the auto-accept fires for undefined/missing execution_mode (backward compat).

### Step 6 — Update existing tests

**File:** `adapters/pty.test.ts`

Existing tests that assert specific CLI flags need updating to pass `execution_mode: 'full-access'` in the config. This keeps them testing the same behavior explicitly.

---

## Acceptance criteria

- [ ] Claude full-access: spawns with `--dangerously-skip-permissions --settings <path>` and hook-only settings.
- [ ] Claude sandbox: spawns with `--permission-mode auto --settings <path>` and sandbox+hook settings.
- [ ] Claude sandbox + read_only: settings file has no `allowWrite` entry.
- [ ] Codex full-access: spawns with `--dangerously-bypass-approvals-and-sandbox`.
- [ ] Codex sandbox: spawns with `--sandbox workspace-write --ask-for-approval never`.
- [ ] Codex sandbox + read_only: spawns with `--sandbox read-only --ask-for-approval never`.
- [ ] Gemini: no flag changes in either mode.
- [ ] Auto-accept dance fires only when NOT in sandbox mode.
- [ ] Missing/undefined execution_mode behaves as `'full-access'` (backward compatible).
- [ ] All existing tests pass (updated where needed).
- [ ] No changes to files outside the stated scope.

---

## Tests

Update existing tests in `adapters/pty.test.ts` and add:

```ts
describe('buildStartArgs execution mode', () => {
  it('claude full-access: --dangerously-skip-permissions', () => { ... });
  it('claude sandbox: --permission-mode auto', () => { ... });
  it('claude sandbox: no --dangerously-skip-permissions', () => { ... });
  it('claude sandbox + read_only: settings file has no allowWrite', () => { ... });
  it('claude sandbox: settings file includes sandbox config block', () => { ... });
  it('codex full-access: --dangerously-bypass-approvals-and-sandbox', () => { ... });
  it('codex sandbox: --sandbox workspace-write --ask-for-approval never', () => { ... });
  it('codex sandbox + read_only: --sandbox read-only', () => { ... });
  it('gemini: no flags in either mode', () => { ... });
  it('undefined execution_mode defaults to full-access behavior', () => { ... });
});

describe('claude auto-accept dance', () => {
  it('fires in full-access mode', () => { ... });
  it('does not fire in sandbox mode', () => { ... });
  it('fires when execution_mode is undefined (backward compat)', () => { ... });
});
```

---

## Verification

```bash
npx vitest run adapters/pty.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** High — the auto-accept guard is the most sensitive change. Wrong conditional = sessions stall (full-access without auto-accept) or get corrupted (sandbox with spurious keystrokes). The `!== 'sandbox'` guard is chosen deliberately for backward safety.
**Risk:** Codex sandbox flags (`--sandbox workspace-write --ask-for-approval never`) need verification against actual CLI. If incorrect, the Codex sandbox path will fail at spawn.
**Rollback:** Revert the commit. No state file changes.
