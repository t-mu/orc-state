---
ref: orch/task-131-align-worker-runtime-contract-docs
epic: orch
status: done
---

# Task 131 — Align Worker Runtime Contract and Docs

Depends on Task 130. Does not block unrelated implementation work, but should land before new worker onboarding changes.

## Scope

**In scope:**
- `orchestrator/contracts.md` — rewrite the worker reporting protocol to match the live PTY + `orc-run-*` runtime
- `adapters/interface.mjs` — remove stale `[ORC_EVENT]` contract language from active adapter comments
- `orchestrator/README.md` — align operator docs with the actual worker lifecycle
- `templates/master-bootstrap-v1.txt`
- `templates/master-bootstrap-codex-v1.txt`
- `templates/master-bootstrap-gemini-v1.txt` — align prompt guidance with the current runtime terminology
- Contract-oriented tests or grep-based assertions covering the active protocol language

**Out of scope:**
- Introducing a new reporting mechanism beyond the current `orc-run-*` CLI flow
- Reworking PTY adapter internals or coordinator lifecycle logic
- Adding new MCP tools

## Context

The orchestrator now runs provider CLIs in PTY sessions and instructs workers to report lifecycle progress through `orc-run-start`, `orc-run-heartbeat`, `orc-run-finish`, and `orc-run-fail`. However, the written contract still describes an older `[ORC_EVENT]` response-parsing protocol and "API-backed workers." That split-brain is dangerous for LLM operators because docs, prompts, and runtime no longer describe the same system.

Task 130 fixes one concrete command mismatch. This task fixes the broader contract drift so the repo has one authoritative story for how workers start, report progress, and recover from stale runs. The result should let an LLM or operator read one document set and execute the runtime correctly without reading implementation code.

**Affected files:**
- `orchestrator/contracts.md` — authoritative runtime contract
- `orchestrator/README.md` — operator-facing runtime guide
- `adapters/interface.mjs` — adapter semantics comments
- `templates/master-bootstrap-v1.txt` — master prompt contract
- `templates/master-bootstrap-codex-v1.txt` — master prompt contract
- `templates/master-bootstrap-gemini-v1.txt` — master prompt contract

## Goals

1. Must remove stale `[ORC_EVENT]` and API-backed-worker language from active-path docs and comments.
2. Must document the PTY-based worker runtime and the `orc-run-*` lifecycle commands as the primary reporting protocol.
3. Must align master bootstrap instructions with the documented runtime terminology.
4. Must add at least one automated check that fails if deprecated protocol language reappears in active worker/runtime docs.

## Implementation

### Step 1 — Rewrite the active worker contract

**File:** `orchestrator/contracts.md`

```md
## Worker Contract

Workers run as headless PTY CLI sessions owned by the coordinator.
When a worker receives TASK_START, it must report lifecycle progress via:
- orc-run-start
- orc-run-heartbeat
- orc-run-finish
- orc-run-fail
```

Remove or explicitly deprecate the `[ORC_EVENT]` sections instead of leaving both protocols described as current.

### Step 2 — Align adapter and README language

**Files:** `adapters/interface.mjs`, `orchestrator/README.md`

Update comments and examples so they describe PTY ownership, CLI reporting, and cross-process attach/probe behavior accurately. Preserve any still-valid adapter invariants.

### Step 3 — Align the master bootstrap templates

**Files:** `templates/master-bootstrap-v1.txt`, `templates/master-bootstrap-codex-v1.txt`, `templates/master-bootstrap-gemini-v1.txt`

```txt
When discussing worker execution, refer to the orc-run-* lifecycle commands.
Do not instruct workers to emit [ORC_EVENT] payloads.
```

Keep provider-specific details intact; only fix runtime contract language.

### Step 4 — Add a drift guard

**File:** `lib/prompts.test.mjs` or a new contract-focused test

```js
it('active worker/runtime docs do not mention [ORC_EVENT] as the primary protocol', () => { ... });
```

The guard should target active runtime docs and templates, not archived backlog files.

## Acceptance criteria

- [ ] `orchestrator/contracts.md` describes `orc-run-*` commands as the current worker reporting protocol.
- [ ] Active runtime docs and comments no longer describe `[ORC_EVENT]` parsing as the current execution path.
- [ ] All master bootstrap templates use runtime terminology that matches the implemented PTY + CLI worker model.
- [ ] An automated test or assertion fails if stale protocol language returns to active-path docs/templates.
- [ ] No changes to files outside the stated scope.

## Tests

Add to `lib/prompts.test.mjs` or a new contract test file:

```js
it('documents orc-run-* as the active worker reporting contract', () => { ... });
it('does not advertise [ORC_EVENT] as the current worker protocol in active docs', () => { ... });
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

```bash
npm run orc:doctor
npm run orc:status
```

## Risk / Rollback

**Risk:** Over-correcting the docs could remove useful historical context or break tests that still assume legacy terminology without updating them.
**Rollback:** `git restore orchestrator/contracts.md orchestrator/README.md adapters/interface.mjs templates/master-bootstrap-v1.txt templates/master-bootstrap-codex-v1.txt templates/master-bootstrap-gemini-v1.txt lib/prompts.test.mjs && nvm use 24 && npm run test:orc`
