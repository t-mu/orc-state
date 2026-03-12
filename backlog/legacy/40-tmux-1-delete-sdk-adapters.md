# Task 40 — Delete SDK Adapter Files

First task in the tmux adapter refactoring series. No dependencies. Blocks Tasks 41–48.

---

## Scope

**In scope:**
- Delete `adapters/claude.mjs`
- Delete `adapters/codex.mjs`
- Delete `adapters/gemini.mjs`
- Delete `adapters/adapters.test.mjs`

**Out of scope:**
- `adapters/index.mjs` — updated in Task 42
- `adapters/interface.mjs` — keep unchanged; the contract it defines is still valid
- All other orchestrator files — do not touch

---

## Context

The current adapter implementations (`claude.mjs`, `codex.mjs`, `gemini.mjs`) call provider
APIs directly using the `@anthropic-ai/sdk`, `openai`, and `@google/generative-ai` SDKs.
This requires API keys and bills per-token. The intended architecture drives real CLI
sessions (e.g. `claude`, `codex`) running in tmux panes — no API key, subscription billing.

These three files must be deleted first, before writing the replacement, so that no stale
SDK patterns influence the new implementation.

`adapters.test.mjs` tests only the SDK adapters. It will be replaced by `tmux.test.mjs`
in Task 48.

**Affected files (deleted):**
- `adapters/claude.mjs` — Anthropic SDK adapter
- `adapters/codex.mjs` — OpenAI SDK adapter
- `adapters/gemini.mjs` — Google Gemini SDK adapter
- `adapters/adapters.test.mjs` — tests for the above three

---

## Goals

1. Must delete all four files listed above.
2. Must not modify any other file in this task.
3. After deletion, `npm test` is expected to fail (adapter imports in `index.mjs` will be broken) — this is acceptable; it will be fixed in Task 42.

---

## Implementation

### Step 1 — Delete the four files

```bash
rm adapters/claude.mjs
rm adapters/codex.mjs
rm adapters/gemini.mjs
rm adapters/adapters.test.mjs
```

No other files change.

---

## Acceptance criteria

- [ ] `adapters/claude.mjs` does not exist
- [ ] `adapters/codex.mjs` does not exist
- [ ] `adapters/gemini.mjs` does not exist
- [ ] `adapters/adapters.test.mjs` does not exist
- [ ] `adapters/interface.mjs` is unchanged
- [ ] No other files are modified

---

## Tests

None — this task only deletes files.

---

## Verification

```bash
ls adapters/
# Expected: index.mjs  interface.mjs  (and nothing else)
```
