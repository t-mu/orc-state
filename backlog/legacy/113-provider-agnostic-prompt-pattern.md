---
ref: orch/task-113-provider-agnostic-prompt-pattern
epic: orch
status: done
---

# Task 113 — Consolidate PROVIDER_BINARIES and Make Prompt Pattern Configurable Per Provider

Depends on Task 112. Blocks none.

## Scope

**In scope:**
- `lib/binaryCheck.mjs` — add a `PROVIDER_PROMPT_PATTERNS` map and a `PROVIDER_SUBMIT_SEQUENCES` map; export them
- `lib/masterPtyForwarder.mjs` — accept an optional `promptPattern` parameter; fall back to a per-provider default from `PROVIDER_PROMPT_PATTERNS`; use a configurable submit sequence
- `cli/start-session.mjs` — pass `master.provider` into `startMasterPtyForwarder` so it resolves the correct pattern

**Out of scope:**
- Changes to worker adapters or headless PTY sessions
- Changes to the PROVIDER_BINARIES or PROVIDER_PACKAGES maps themselves
- Changing how MCP wiring or bootstrap templates are structured (Task 112)

## Context

`masterPtyForwarder.mjs` hardcodes two Claude-specific assumptions:

```js
// masterPtyForwarder.mjs:
const PROMPT_PATTERN = />\s*$/;  // Claude Code prompt shape: "> "
// ...
masterPty.write(payload);
masterPty.write('\r');            // \r submits in Claude Code raw mode
```

`/>\s*$/` matches the Claude Code interactive prompt. Codex uses `$ ` or `❯ ` prompts; Gemini CLI uses a different shape. If a non-Claude master runs, the forwarder never detects the idle state and never injects notifications.

`PROVIDER_BINARIES` is defined in `binaryCheck.mjs` and imported by `start-session.mjs`. No other file needs the binary names. The prompt pattern and submit sequence, however, are needed at forwarder runtime and belong in the same provider-capability registry.

**Affected files:**
- `lib/binaryCheck.mjs` — new `PROVIDER_PROMPT_PATTERNS`, `PROVIDER_SUBMIT_SEQUENCES` exports
- `lib/masterPtyForwarder.mjs` — accept `provider` or `promptPattern`/`submitSequence` options
- `cli/start-session.mjs` — pass provider to `startMasterPtyForwarder`

## Goals

1. Must export `PROVIDER_PROMPT_PATTERNS` from `binaryCheck.mjs` mapping provider → RegExp.
2. Must export `PROVIDER_SUBMIT_SEQUENCES` from `binaryCheck.mjs` mapping provider → string (e.g. `'\r'`).
3. `startMasterPtyForwarder` must accept an `options` object with optional `promptPattern` (RegExp) and `submitSequence` (string) overrides.
4. When options are not provided, `startMasterPtyForwarder` must accept a `provider` string and look up defaults from `PROVIDER_PROMPT_PATTERNS` / `PROVIDER_SUBMIT_SEQUENCES`.
5. Must fall back to the current Claude defaults if the provider is unknown.
6. Must not break the existing Claude forwarder behaviour.

## Implementation

### Step 1 — Add maps to binaryCheck.mjs

**File:** `lib/binaryCheck.mjs`

```js
export const PROVIDER_PROMPT_PATTERNS = {
  claude:  />\s*$/,           // Claude Code: ends with "> "
  codex:   /[$❯]\s*$/,       // Codex: ends with "$ " or "❯ "
  gemini:  /[>$❯]\s*$/,      // Gemini CLI: TBD — conservative fallback
};

export const PROVIDER_SUBMIT_SEQUENCES = {
  claude:  '\r',
  codex:   '\r',
  gemini:  '\r',
};
```

### Step 2 — Update startMasterPtyForwarder signature

**File:** `lib/masterPtyForwarder.mjs`

```js
// Before:
export function startMasterPtyForwarder(stateDir, masterPty, ptyDataEmitter) {

// After:
export function startMasterPtyForwarder(stateDir, masterPty, ptyDataEmitter, options = {}) {
  const {
    provider = 'claude',
    promptPattern = PROVIDER_PROMPT_PATTERNS[provider] ?? />\s*$/,
    submitSequence = PROVIDER_SUBMIT_SEQUENCES[provider] ?? '\r',
  } = options;
```

Replace uses of `PROMPT_PATTERN` with `promptPattern` and `'\r'` with `submitSequence` inside the function body. Remove the top-level `const PROMPT_PATTERN` constant.

### Step 3 — Pass provider in start-session.mjs

**File:** `cli/start-session.mjs`

```js
// Before:
stopForwarder = startMasterPtyForwarder(STATE_DIR, masterPty, masterPty);

// After:
stopForwarder = startMasterPtyForwarder(STATE_DIR, masterPty, masterPty, { provider: master.provider });
```

## Acceptance criteria

- [ ] `PROVIDER_PROMPT_PATTERNS` and `PROVIDER_SUBMIT_SEQUENCES` are exported from `binaryCheck.mjs`.
- [ ] `startMasterPtyForwarder` accepts an `options` object with `provider`, `promptPattern`, and `submitSequence`.
- [ ] When called with `{ provider: 'claude' }`, behaviour is identical to the current hardcoded version.
- [ ] When called with `{ provider: 'codex' }`, `promptPattern` resolves to the Codex pattern.
- [ ] Callers that pass no options (e.g. in tests) still work via defaults.
- [ ] `start-session.mjs` passes `{ provider: master.provider }` to `startMasterPtyForwarder`.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `lib/masterPtyForwarder.test.mjs`

```js
it('uses the provided promptPattern option instead of the default Claude pattern');
it('falls back to Claude pattern when provider is unknown');
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```
