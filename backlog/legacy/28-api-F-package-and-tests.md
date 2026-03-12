# Task F — Package, Dependencies, and Test Coverage

Depends on Tasks A, B, C, D, E. Final integration task.

## Scope

**In scope:**
- Add `@anthropic-ai/sdk`, `openai`, and `@google/generative-ai` to
  `orchestrator/package.json` dependencies (as optional peer deps)
- Update `e2e/orchestrationLifecycle.e2e.test.mjs` to use mocked API
  adapters instead of tmux mocks; assert event-name presence only (not run_id correlation)
- Update `orchestrator/contracts.md` — session handle format, progress protocol,
  remove all tmux references
- Write `orchestrator/README.md` — env vars table, quick-start (register → start
  coordinator), session model, link to contracts.md
- Verify the full test suite passes at 0 failures
- Verify `npm pack` (dry run) from `orchestrator/` produces a valid package

**Out of scope:**
- Publishing to npm (pre-publish work only)
- Changing any source files other than the ones listed above
- Adding streaming support to adapters (future enhancement)
- Session persistence across coordinator restarts (future enhancement)

---

## Context

After Tasks A–E, the orchestrator is functionally migrated to API-based operation. This
task completes the work by:

1. **Declaring SDK dependencies** — currently the SDKs are installed manually (Task B
   noted `npm install @anthropic-ai/sdk openai @google/generative-ai` as a prerequisite).
   They need to be declared in `orchestrator/package.json` so that consumers who install
   `@t-mu/orc-state` get them automatically. Since each provider SDK is only needed
   if that provider is actually used, they are declared as `peerDependencies` with
   `peerDependenciesMeta.optional: true` — this means npm will warn if they are missing
   but will not fail the install.

2. **Updating the e2e test** — `orchestrationLifecycle.e2e.test.mjs` currently exercises
   the full coordinator loop with a tmux adapter mock. It needs to be updated to inject
   a mock API adapter that returns `[ORC_EVENT]`-formatted response strings.

3. **Updating contracts.md** — the contracts document is the source of truth for
   contributors and LLM agents. It references tmux session handles, the `orc-progress`
   CLI protocol, and tmux-specific agent session semantics. All of these need to be updated
   to reflect the API model.

**Affected files:**
- `orchestrator/package.json` — add peerDependencies + peerDependenciesMeta
- `e2e/orchestrationLifecycle.e2e.test.mjs` — update to mock API adapters
- `orchestrator/contracts.md` — update session handle format, progress protocol
- `orchestrator/README.md` — new file

---

## Goals

1. Must declare `@anthropic-ai/sdk`, `openai`, `@google/generative-ai` as optional peer
   dependencies in `orchestrator/package.json`
2. Must update the e2e test to use an injected mock API adapter (no tmux calls)
3. Must verify the coordinator loop end-to-end with the mock adapter:
   - `start()` returns a `claude:<uuid>` handle
   - `send()` returns a response string with embedded `[ORC_EVENT]` lines
   - Coordinator extracts events and writes them to `events.jsonl`
4. Must update `contracts.md` to describe the API session handle format and `[ORC_EVENT]`
   progress protocol
5. Must remove all tmux references from `contracts.md`
6. Must write `orchestrator/README.md` with: required env vars table, quick-start
   steps (register agent, start coordinator), session model summary, link to contracts.md
7. Full test suite (unit + e2e) must pass at 0 failures after all tasks are merged

---

## Implementation

### Step 1 — Update `orchestrator/package.json`

**File:** `orchestrator/package.json`

Add `peerDependencies` and `peerDependenciesMeta` sections:

```json
{
  "name": "@t-mu/orc-state",
  "version": "0.1.0",
  "dependencies": {
    "ajv": "^8.12.6"
  },
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.39.0",
    "openai": ">=4.0.0",
    "@google/generative-ai": ">=0.21.0"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true },
    "openai": { "optional": true },
    "@google/generative-ai": { "optional": true }
  },
  "devDependencies": {
    "vitest": "4.0.18"
  }
}
```

Verify installed versions with:

```bash
node -e "console.log(require('./node_modules/@anthropic-ai/sdk/package.json').version)"
node -e "console.log(require('./node_modules/openai/package.json').version)"
node -e "console.log(require('./node_modules/@google/generative-ai/package.json').version)"
```

Pin the ranges to `>=<installed_major>.<minor>.0` if you want tighter pinning, but
semver `>=X.Y.0` is sufficient for peer deps.

### Step 2 — Update `e2e/orchestrationLifecycle.e2e.test.mjs`

**File:** `e2e/orchestrationLifecycle.e2e.test.mjs`

The e2e test exercises the coordinator loop by calling the coordinator's exported
functions directly (not by spawning a process). Identify and update the adapter mock:

**Current pattern (tmux-based):**
```js
const mockAdapter = {
  start: vi.fn().mockResolvedValue({ session_handle: 'tmux:orch:worker-01', provider_ref: {} }),
  send: vi.fn().mockResolvedValue(undefined),  // void return
  attach: vi.fn(),
  heartbeatProbe: vi.fn().mockResolvedValue(true),
  stop: vi.fn().mockResolvedValue(undefined),
};
```

**Replace with API-based mock:**
```js
function makeApiMockAdapter(agentId = 'worker-01') {
  let callCount = 0;
  return {
    start: vi.fn().mockResolvedValue({
      session_handle: `claude:mock-session-${agentId}`,
      provider_ref: { model: 'claude-sonnet-4-6' },
    }),
    send: vi.fn().mockImplementation(async (_handle, _text) => {
      callCount++;
      const now = new Date().toISOString();
      // Return a realistic API response with embedded [ORC_EVENT] lines
      return [
        `I'll start on this task immediately.`,
        `[ORC_EVENT] {"event":"run_started","run_id":"<run_id>","agent_id":"${agentId}","ts":"${now}"}`,
        `Working on implementation...`,
        `[ORC_EVENT] {"event":"run_finished","run_id":"<run_id>","agent_id":"${agentId}","ts":"${now}"}`,
        `Task complete.`,
      ].join('\n');
    }),
    attach: vi.fn(),
    heartbeatProbe: vi.fn().mockResolvedValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
    _getCallCount: () => callCount,
  };
}
```

**Note:** The mock `send()` uses `<run_id>` as a placeholder. In a real test the run_id
is not known ahead of time — either:
- Accept that `parseOrcEvents` will find events with `run_id: "<run_id>"` (literally) and
  verify the `event` field only, OR
- Update the mock to accept the text argument and extract `run_id` from the TASK_START
  block in the envelope.

The simpler option: verify that `events.jsonl` contains a `run_started` and `run_finished`
event by event name, not by run_id match.

**Updated assertions in e2e test:**

```js
it('coordinator loop dispatches task and records run_started event from API response', async () => {
  // ... setup state dir with backlog, agents, claims ...
  const adapter = makeApiMockAdapter('worker-01');
  vi.mock('../adapters/index.mjs', () => ({ createAdapter: () => adapter }));

  // Run one coordinator tick
  await tick();

  // Verify adapter.send was called with the task envelope
  expect(adapter.send).toHaveBeenCalled();

  // Verify events.jsonl contains run_started extracted from response
  const events = readEvents(dir);
  expect(events.some((e) => e.event === 'run_started')).toBe(true);
  expect(events.some((e) => e.event === 'run_finished')).toBe(true);
});
```

### Step 3 — Update `orchestrator/contracts.md`

**File:** `orchestrator/contracts.md`

Make the following targeted changes (do not rewrite the entire document):

**Section: Session Handles**

Replace:
```
Session handles use the format "tmux:<session>:<window>" (e.g. "tmux:orch:worker-01").
```

With:
```
Session handles use the format "<provider>:<uuid>" (e.g. "claude:3f2a...", "openai:7b1c...",
"gemini:9e4d..."). The handle is opaque to the orchestrator core — only the adapter
interprets it. Handles are not stable across coordinator restarts; `ensureSessionReady()`
calls `adapter.start()` to obtain a fresh handle when an agent has no active session.
```

**Section: Progress Events / Worker Contract**

Replace the `orc-progress` shell command block with:
```
Workers report lifecycle events by embedding [ORC_EVENT] JSON lines in their API response:

  [ORC_EVENT] {"event":"run_started","run_id":"<id>","agent_id":"<id>","ts":"<ISO8601>"}
  [ORC_EVENT] {"event":"run_finished","run_id":"<id>","agent_id":"<id>","ts":"<ISO8601>"}

The coordinator reads the full response text from adapter.send() and extracts these lines
automatically via parseOrcEvents() (lib/responseParser.mjs).

The CLI command `orc-progress` remains available for human workers and backward
compatibility but is not used by API-backed agents.
```

**Section: Adapter Interface**

Update the `send()` signature description:
```
send(sessionHandle, text) → Promise<string>
  Send a prompt and return the full response text. The response may contain [ORC_EVENT]
  lines. The coordinator parses and records them. Throws on SDK error.
```

Remove any section that mentions tmux, `parseHandle`, `tmuxTarget`, or `sendTmuxPrompt`.

**Section: Provider Support**

Add a table of required environment variables:
```
| Provider | Adapter name | Required env var     |
|----------|-------------|----------------------|
| Claude   | claude      | ANTHROPIC_API_KEY    |
| Codex    | codex       | OPENAI_API_KEY       |
| Gemini   | gemini      | GOOGLE_API_KEY       |
```

---

## Acceptance criteria

- [ ] `orchestrator/package.json` declares `@anthropic-ai/sdk`, `openai`, and
  `@google/generative-ai` as optional peer dependencies
- [ ] `npm pack --dry-run` from `orchestrator/` exits 0 and lists expected files
- [ ] E2e test uses API-based mock adapter (no `tmux:` session handles)
- [ ] E2e test verifies that `run_started` and `run_finished` events are extracted from
  the mock response and written to `events.jsonl`
- [ ] `contracts.md` session handle section describes `<provider>:<uuid>` format
- [ ] `contracts.md` progress section describes `[ORC_EVENT]` protocol
- [ ] `contracts.md` contains no references to `tmux:` session handle format or
  `sendTmuxPrompt` / `parseHandle`
- [ ] `orchestrator/README.md` exists and contains env vars table, quick-start, and
  a link to `contracts.md`
- [ ] Full test suite (all unit + e2e) passes at 0 failures
- [ ] `node -e "import('@t-mu/orc-state')"` → exits 0 without starting daemon
- [ ] `grep -r "tmux" orchestrator/contracts.md` → no matches

---

## Tests

The e2e test update is the primary deliverable (Step 2). Target test count after all 6
tasks:

| Suite | Baseline | A | B (replaces) | C | D | E | F total |
|-------|----------|---|------|---|---|---|---------|
| adapters | ~30 | +1 | ~30 (rewritten) | — | — | — | ~31 |
| responseParser | 0 | — | — | +9 | — | — | 9 |
| doctor/preflight | ~8 | — | — | — | — | +3 | ~11 |
| e2e | 4 | — | — | — | — | — | 4 (updated) |
| all others | ~182 | — | — | — | — | — | ~182 |
| **Total** | **224** | | | | | | **~237** |

---

## Verification

```bash
# Full suite — must be 0 failures
nvm use 22 && npm run test:orc

# Package dry-run — must list expected files
cd orchestrator && npm pack --dry-run 2>&1 | head -40

# Import guard — must print 'ok' without starting daemon
node -e "import('./coordinator.mjs').then(() => console.log('ok'))"

# No tmux in contracts
grep -i "tmux" orchestrator/contracts.md
# Expected: no output

# SDK peer deps declared
node -e "const p=require('./orchestrator/package.json'); console.log(JSON.stringify(p.peerDependencies,null,2))"
```

## Risk / Rollback

**Risk:** `peerDependencies` are not automatically installed when the package is used as a
workspace member (which is the current setup). Ensure that the root `package.json` or the
`orchestrator/package.json` has the SDKs listed so they are installed in the workspace.
Task B already installs them via `npm install` in the `orchestrator/` directory — verify
they appear in `orchestrator/node_modules/` or the root `node_modules/`.

**Risk:** The e2e test mock's `send()` returns a literal `<run_id>` placeholder. If any
assertion compares run_id values, it will fail. Scope assertions to event names only, or
update the mock to parse the envelope and echo back the real run_id.

**Rollback:** `git checkout orchestrator/package.json orchestrator/contracts.md
e2e/orchestrationLifecycle.e2e.test.mjs` restores this task. No state files
are modified.
