# Task B — Rewrite Provider Adapters with SDK Calls

Depends on Task A. Blocks Tasks D, E, F.

## Scope

**In scope:**
- Replace `adapters/claude.mjs` with Anthropic SDK implementation
- Replace `adapters/codex.mjs` with OpenAI SDK implementation
- Replace `adapters/gemini.mjs` with Google Generative AI SDK implementation
- Remove all tmux utilities (`parseHandle`, `tmuxTarget`, `sendTmuxPrompt`, `runTmux`,
  `isLikelyWorkerCommand`) from all adapter files
- Replace all tests in `adapters/adapters.test.mjs` with SDK-mock-based tests
- Update `lib/providers.mjs` if needed

**Out of scope:**
- `interface.mjs` (Task A)
- `adapters/index.mjs` factory wiring (no changes needed — factory pattern unchanged)
- `coordinator.mjs` (Task D)
- CLI tools (Task E)
- `orchestrator/package.json` SDK dep declarations (Task F — but install SDKs locally first)

---

## Context

All three current adapters are thin wrappers around tmux shell commands. The
`createCodexAdapter` in `codex.mjs` also exports shared utilities (`parseHandle`,
`tmuxTarget`, `sendTmuxPrompt`) used by `claude.mjs` and `gemini.mjs`. After this task,
all three adapters use their respective Node.js SDKs and maintain in-memory conversation
history (a `Map<sessionHandle, SessionState>`).

The conversation model for all three adapters follows the same pattern:
- `start()` — generate a UUID session handle, initialize a `SessionState` object in a
  local `Map`, send nothing to the API yet (the system prompt is passed on first `send()`)
- `send(handle, text)` — append user message, call the SDK, append assistant response,
  return response text
- `attach(handle)` — print the last assistant message to stdout; no-op if none
- `heartbeatProbe(handle)` — return `sessions.has(handle) && Boolean(apiKey)`
- `stop(handle)` — `sessions.delete(handle)`

Session handles use the format `"<provider>:<uuid>"`:
- Claude: `"claude:3f2a1b..."`
- OpenAI/Codex: `"openai:7b1c2d..."`
- Gemini: `"gemini:9e4d5f..."`

**Note on bootstrap:** In the API model, the session bootstrap (worker identity, event
format instructions) is passed as the `config.system_prompt` argument to `start()`, which
stores it in `SessionState`. On the first `send()` call the system prompt is applied as
the SDK-level system parameter, not as a user message.

**Affected files:**
- `adapters/codex.mjs` — full rewrite (OpenAI SDK)
- `adapters/claude.mjs` — full rewrite (Anthropic SDK)
- `adapters/gemini.mjs` — full rewrite (Google Generative AI SDK)
- `adapters/adapters.test.mjs` — full rewrite (mock SDK, no tmux)
- `lib/providers.mjs` — verify list is still accurate (no change expected)

---

## Goals

1. Must implement `start / send / attach / heartbeatProbe / stop` for all three providers
   using their official Node.js SDKs
2. `send()` must return the full response text as a string
3. Must maintain multi-turn conversation history across multiple `send()` calls on the same
   session handle
4. Must not make any tmux shell calls — no `spawnSync('tmux', ...)` anywhere
5. `heartbeatProbe()` must return false (not throw) when the API key env var is absent
6. `stop()` must clear the session from memory without throwing
7. All adapter tests must use vitest `vi.mock()` or injected SDK factory mocks — no real
   API calls in tests
8. `assertAdapterContract()` must pass for all three new adapters

---

## Implementation

### Step 1 — Rewrite `adapters/codex.mjs` (OpenAI)

**File:** `adapters/codex.mjs`

Replace the entire file:

```js
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

/**
 * Create an OpenAI (Codex) provider adapter.
 *
 * @param {object} options
 * @param {string} [options.apiKey]   Defaults to OPENAI_API_KEY env var.
 * @param {string} [options.model]    Default model. Can be overridden per-session via config.model.
 * @param {Function} [options.clientFactory]  Injectable for tests: (apiKey) => OpenAI-like client.
 */
export function createCodexAdapter({
  apiKey = process.env.OPENAI_API_KEY,
  model = 'gpt-4o',
  clientFactory = (key) => new OpenAI({ apiKey: key }),
} = {}) {
  const client = clientFactory(apiKey);
  // Map<sessionHandle, { systemPrompt, model, messages }>
  const sessions = new Map();

  return {
    async start(agentId, config = {}) {
      const handle = `openai:${randomUUID()}`;
      sessions.set(handle, {
        systemPrompt: config.system_prompt ?? '',
        model: config.model ?? model,
        messages: [],
      });
      return {
        session_handle: handle,
        provider_ref: { model: config.model ?? model },
      };
    },

    async send(sessionHandle, text) {
      const session = sessions.get(sessionHandle);
      if (!session) throw new Error(`Unknown session handle: ${sessionHandle}`);

      session.messages.push({ role: 'user', content: text });

      const msgs = session.systemPrompt
        ? [{ role: 'system', content: session.systemPrompt }, ...session.messages]
        : session.messages;

      const completion = await client.chat.completions.create({
        model: session.model,
        messages: msgs,
        max_tokens: 8192,
      });

      const responseText = completion.choices[0]?.message?.content ?? '';
      session.messages.push({ role: 'assistant', content: responseText });
      return responseText;
    },

    attach(sessionHandle) {
      const session = sessions.get(sessionHandle);
      const last = session?.messages.filter((m) => m.role === 'assistant').at(-1);
      console.log(last?.content ?? '(no messages yet)');
    },

    async heartbeatProbe(sessionHandle) {
      return sessions.has(sessionHandle) && Boolean(apiKey);
    },

    async stop(sessionHandle) {
      sessions.delete(sessionHandle);
    },
  };
}
```

### Step 2 — Rewrite `adapters/claude.mjs` (Anthropic)

**File:** `adapters/claude.mjs`

Replace the entire file (remove all tmux imports and utilities):

```js
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Create an Anthropic (Claude) provider adapter.
 *
 * @param {object} options
 * @param {string} [options.apiKey]        Defaults to ANTHROPIC_API_KEY env var.
 * @param {string} [options.model]         Default model.
 * @param {Function} [options.clientFactory]  Injectable for tests.
 */
export function createClaudeAdapter({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = 'claude-sonnet-4-6',
  clientFactory = (key) => new Anthropic({ apiKey: key }),
} = {}) {
  const client = clientFactory(apiKey);
  // Map<sessionHandle, { systemPrompt, model, messages }>
  const sessions = new Map();

  return {
    async start(agentId, config = {}) {
      const handle = `claude:${randomUUID()}`;
      sessions.set(handle, {
        systemPrompt: config.system_prompt ?? '',
        model: config.model ?? model,
        messages: [],
      });
      return {
        session_handle: handle,
        provider_ref: { model: config.model ?? model },
      };
    },

    async send(sessionHandle, text) {
      const session = sessions.get(sessionHandle);
      if (!session) throw new Error(`Unknown session handle: ${sessionHandle}`);

      session.messages.push({ role: 'user', content: text });

      const response = await client.messages.create({
        model: session.model,
        max_tokens: 8192,
        ...(session.systemPrompt ? { system: session.systemPrompt } : {}),
        messages: session.messages,
      });

      const responseText = response.content[0]?.text ?? '';
      session.messages.push({ role: 'assistant', content: responseText });
      return responseText;
    },

    attach(sessionHandle) {
      const session = sessions.get(sessionHandle);
      const last = session?.messages.filter((m) => m.role === 'assistant').at(-1);
      console.log(last?.content ?? '(no messages yet)');
    },

    async heartbeatProbe(sessionHandle) {
      return sessions.has(sessionHandle) && Boolean(apiKey);
    },

    async stop(sessionHandle) {
      sessions.delete(sessionHandle);
    },
  };
}
```

### Step 3 — Rewrite `adapters/gemini.mjs` (Google)

**File:** `adapters/gemini.mjs`

Replace the entire file:

```js
import { randomUUID } from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Create a Google Gemini provider adapter.
 *
 * @param {object} options
 * @param {string} [options.apiKey]        Defaults to GOOGLE_API_KEY env var.
 * @param {string} [options.model]         Default model.
 * @param {Function} [options.clientFactory]  Injectable for tests: (apiKey) => GoogleGenerativeAI-like.
 */
export function createGeminiAdapter({
  apiKey = process.env.GOOGLE_API_KEY,
  model = 'gemini-1.5-pro',
  clientFactory = (key) => new GoogleGenerativeAI(key),
} = {}) {
  const genAI = clientFactory(apiKey);
  // Map<sessionHandle, { systemInstruction, modelName, history }>
  // history uses Gemini format: [{ role: 'user'|'model', parts: [{ text }] }]
  const sessions = new Map();

  return {
    async start(agentId, config = {}) {
      const handle = `gemini:${randomUUID()}`;
      sessions.set(handle, {
        systemInstruction: config.system_prompt ?? '',
        modelName: config.model ?? model,
        history: [],
      });
      return {
        session_handle: handle,
        provider_ref: { model: config.model ?? model },
      };
    },

    async send(sessionHandle, text) {
      const session = sessions.get(sessionHandle);
      if (!session) throw new Error(`Unknown session handle: ${sessionHandle}`);

      const genModel = genAI.getGenerativeModel({
        model: session.modelName,
        ...(session.systemInstruction ? { systemInstruction: session.systemInstruction } : {}),
      });

      const chat = genModel.startChat({ history: session.history });
      const result = await chat.sendMessage(text);
      const responseText = result.response.text();

      session.history.push({ role: 'user', parts: [{ text }] });
      session.history.push({ role: 'model', parts: [{ text: responseText }] });
      return responseText;
    },

    attach(sessionHandle) {
      const session = sessions.get(sessionHandle);
      const last = session?.history.filter((m) => m.role === 'model').at(-1);
      console.log(last?.parts[0]?.text ?? '(no messages yet)');
    },

    async heartbeatProbe(sessionHandle) {
      return sessions.has(sessionHandle) && Boolean(apiKey);
    },

    async stop(sessionHandle) {
      sessions.delete(sessionHandle);
    },
  };
}
```

### Step 4 — Rewrite `adapters/adapters.test.mjs`

**File:** `adapters/adapters.test.mjs`

Replace the entire file. Use `vi.fn()` for injected SDK mocks — no `vi.mock()` needed
since all adapters accept a `clientFactory` option:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCodexAdapter } from './codex.mjs';
import { createClaudeAdapter } from './claude.mjs';
import { createGeminiAdapter } from './gemini.mjs';
import { assertAdapterContract } from './interface.mjs';
import { createAdapter } from './index.mjs';

// ── Shared mock builder helpers ──────────────────────────────────────────────

function makeOpenAIClient(responseText = 'openai response') {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseText } }],
        }),
      },
    },
  };
}

function makeAnthropicClient(responseText = 'claude response') {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ text: responseText }],
      }),
    },
  };
}

function makeGeminiClient(responseText = 'gemini response') {
  const sendMessage = vi.fn().mockResolvedValue({
    response: { text: () => responseText },
  });
  return {
    getGenerativeModel: vi.fn().mockReturnValue({
      startChat: vi.fn().mockReturnValue({ sendMessage }),
    }),
    _sendMessage: sendMessage,
  };
}

// ── createCodexAdapter ────────────────────────────────────────────────────────

describe('createCodexAdapter', () => {
  it('satisfies the adapter contract', () => {
    const adapter = createCodexAdapter({ clientFactory: () => makeOpenAIClient() });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('start() returns session_handle in openai:<uuid> format', async () => {
    const adapter = createCodexAdapter({ clientFactory: () => makeOpenAIClient() });
    const { session_handle } = await adapter.start('agent-01');
    expect(session_handle).toMatch(/^openai:[0-9a-f-]{36}$/);
  });

  it('send() calls OpenAI chat.completions.create and returns response text', async () => {
    const client = makeOpenAIClient('hello from openai');
    const adapter = createCodexAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-01');
    const result = await adapter.send(session_handle, 'do something');
    expect(result).toBe('hello from openai');
    expect(client.chat.completions.create).toHaveBeenCalledOnce();
  });

  it('send() appends messages to conversation history for multi-turn', async () => {
    const client = makeOpenAIClient('turn 2 response');
    const adapter = createCodexAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-01');
    await adapter.send(session_handle, 'turn 1');
    await adapter.send(session_handle, 'turn 2');
    const [, call2] = client.chat.completions.create.mock.calls;
    // Second call should include the prior assistant message in messages array
    const msgs = call2[0].messages;
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('send() includes system prompt when set in start() config', async () => {
    const client = makeOpenAIClient();
    const adapter = createCodexAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-01', { system_prompt: 'you are a worker' });
    await adapter.send(session_handle, 'hi');
    const [call] = client.chat.completions.create.mock.calls;
    const msgs = call[0].messages;
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'you are a worker' });
  });

  it('send() throws when session handle is unknown', async () => {
    const adapter = createCodexAdapter({ clientFactory: () => makeOpenAIClient() });
    await expect(adapter.send('openai:nonexistent', 'hi')).rejects.toThrow('Unknown session handle');
  });

  it('heartbeatProbe() returns true for known session with api key', async () => {
    const adapter = createCodexAdapter({ apiKey: 'test-key', clientFactory: () => makeOpenAIClient() });
    const { session_handle } = await adapter.start('agent-01');
    await expect(adapter.heartbeatProbe(session_handle)).resolves.toBe(true);
  });

  it('heartbeatProbe() returns false for unknown session', async () => {
    const adapter = createCodexAdapter({ apiKey: 'test-key', clientFactory: () => makeOpenAIClient() });
    await expect(adapter.heartbeatProbe('openai:unknown')).resolves.toBe(false);
  });

  it('heartbeatProbe() returns false when apiKey is absent', async () => {
    const adapter = createCodexAdapter({ apiKey: '', clientFactory: () => makeOpenAIClient() });
    const { session_handle } = await adapter.start('agent-01');
    await expect(adapter.heartbeatProbe(session_handle)).resolves.toBe(false);
  });

  it('stop() removes the session so subsequent send() throws', async () => {
    const adapter = createCodexAdapter({ clientFactory: () => makeOpenAIClient() });
    const { session_handle } = await adapter.start('agent-01');
    await adapter.stop(session_handle);
    await expect(adapter.send(session_handle, 'hi')).rejects.toThrow('Unknown session handle');
  });

  it('attach() prints last assistant message to stdout', async () => {
    const client = makeOpenAIClient('final answer');
    const adapter = createCodexAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-01');
    await adapter.send(session_handle, 'question');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    adapter.attach(session_handle);
    expect(spy).toHaveBeenCalledWith('final answer');
    spy.mockRestore();
  });

  it('attach() prints "(no messages yet)" when no sends have occurred', async () => {
    const adapter = createCodexAdapter({ clientFactory: () => makeOpenAIClient() });
    const { session_handle } = await adapter.start('agent-01');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    adapter.attach(session_handle);
    expect(spy).toHaveBeenCalledWith('(no messages yet)');
    spy.mockRestore();
  });
});

// ── createClaudeAdapter ───────────────────────────────────────────────────────

describe('createClaudeAdapter', () => {
  it('satisfies the adapter contract', () => {
    const adapter = createClaudeAdapter({ clientFactory: () => makeAnthropicClient() });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('start() returns session_handle in claude:<uuid> format', async () => {
    const adapter = createClaudeAdapter({ clientFactory: () => makeAnthropicClient() });
    const { session_handle } = await adapter.start('agent-02');
    expect(session_handle).toMatch(/^claude:[0-9a-f-]{36}$/);
  });

  it('send() calls Anthropic messages.create and returns response text', async () => {
    const client = makeAnthropicClient('hello from claude');
    const adapter = createClaudeAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-02');
    const result = await adapter.send(session_handle, 'do something');
    expect(result).toBe('hello from claude');
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it('send() includes system prompt as top-level system param', async () => {
    const client = makeAnthropicClient();
    const adapter = createClaudeAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-02', { system_prompt: 'you are a worker' });
    await adapter.send(session_handle, 'hi');
    const [call] = client.messages.create.mock.calls;
    expect(call[0].system).toBe('you are a worker');
  });

  it('send() omits system param when system_prompt is empty', async () => {
    const client = makeAnthropicClient();
    const adapter = createClaudeAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-02');
    await adapter.send(session_handle, 'hi');
    const [call] = client.messages.create.mock.calls;
    expect(call[0].system).toBeUndefined();
  });

  it('heartbeatProbe() returns false for absent api key', async () => {
    const adapter = createClaudeAdapter({ apiKey: '', clientFactory: () => makeAnthropicClient() });
    const { session_handle } = await adapter.start('agent-02');
    await expect(adapter.heartbeatProbe(session_handle)).resolves.toBe(false);
  });
});

// ── createGeminiAdapter ───────────────────────────────────────────────────────

describe('createGeminiAdapter', () => {
  it('satisfies the adapter contract', () => {
    const adapter = createGeminiAdapter({ clientFactory: () => makeGeminiClient() });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('start() returns session_handle in gemini:<uuid> format', async () => {
    const adapter = createGeminiAdapter({ clientFactory: () => makeGeminiClient() });
    const { session_handle } = await adapter.start('agent-03');
    expect(session_handle).toMatch(/^gemini:[0-9a-f-]{36}$/);
  });

  it('send() calls getGenerativeModel().startChat().sendMessage() and returns text', async () => {
    const client = makeGeminiClient('hello from gemini');
    const adapter = createGeminiAdapter({ clientFactory: () => client });
    const { session_handle } = await adapter.start('agent-03');
    const result = await adapter.send(session_handle, 'do something');
    expect(result).toBe('hello from gemini');
    expect(client._sendMessage).toHaveBeenCalledOnce();
  });

  it('heartbeatProbe() returns false for absent api key', async () => {
    const adapter = createGeminiAdapter({ apiKey: '', clientFactory: () => makeGeminiClient() });
    const { session_handle } = await adapter.start('agent-03');
    await expect(adapter.heartbeatProbe(session_handle)).resolves.toBe(false);
  });
});

// ── createAdapter (factory) ───────────────────────────────────────────────────

describe('createAdapter', () => {
  it('creates a codex adapter satisfying the contract', () => {
    const adapter = createAdapter('codex', { clientFactory: () => makeOpenAIClient() });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('creates a claude adapter satisfying the contract', () => {
    const adapter = createAdapter('claude', { clientFactory: () => makeAnthropicClient() });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('creates a gemini adapter satisfying the contract', () => {
    const adapter = createAdapter('gemini', { clientFactory: () => makeGeminiClient() });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('throws for unknown provider', () => {
    expect(() => createAdapter('unknown-provider')).toThrow('Unknown provider');
  });
});

// ── assertAdapterContract ─────────────────────────────────────────────────────

describe('assertAdapterContract', () => {
  it('accepts a fully conforming adapter', () => {
    const full = { start: () => {}, send: () => {}, attach: () => {}, heartbeatProbe: () => {}, stop: () => {} };
    expect(() => assertAdapterContract(full)).not.toThrow();
  });

  it('throws when a method is missing', () => {
    const partial = { start: () => {}, send: () => {}, attach: () => {}, heartbeatProbe: () => {} };
    expect(() => assertAdapterContract(partial)).toThrow('stop');
  });

  it('accepts adapter where send() returns a string', async () => {
    const adapter = {
      start: async () => ({ session_handle: 'test:1', provider_ref: {} }),
      send: async () => 'response text',
      attach: () => {},
      heartbeatProbe: async () => true,
      stop: async () => {},
    };
    expect(() => assertAdapterContract(adapter)).not.toThrow();
    await expect(adapter.send('test:1', 'hi')).resolves.toBe('response text');
  });
});
```

---

## Acceptance criteria

- [ ] `codex.mjs` contains no `spawnSync`, no `tmux`, no `parseHandle`, no `tmuxTarget`
- [ ] `claude.mjs` contains no `spawnSync`, no `tmux`, no import from `./codex.mjs`
- [ ] `gemini.mjs` contains no `spawnSync`, no `tmux`
- [ ] All three adapters pass `assertAdapterContract()`
- [ ] `send()` returns response text (string) for all three adapters
- [ ] Multi-turn conversation history accumulates correctly across `send()` calls
- [ ] `heartbeatProbe()` returns `false` (not throw) when API key is empty string
- [ ] `stop()` causes subsequent `send()` to throw `"Unknown session handle"`
- [ ] `attach()` prints `"(no messages yet)"` when called before any `send()`
- [ ] `attach()` prints the last assistant response after at least one `send()`
- [ ] All adapter tests pass with mocked SDK clients (no real network calls)
- [ ] `grep -r "spawnSync\|tmux" adapters/` returns no results

---

## Tests

Test file: `adapters/adapters.test.mjs` — full replacement as shown in Step 4.

Target coverage:
- All 5 interface methods for each of the 3 adapters (15 method groups)
- Multi-turn history accumulation (1 test per adapter minimum)
- Unknown session handle error path (1 test per adapter)
- Missing API key → false heartbeat (1 test per adapter)
- `assertAdapterContract` positive + negative cases (2 tests)

---

## Verification

```bash
# Install SDKs first (Task F will add them to package.json; for now install manually)
cd orchestrator && npm install @anthropic-ai/sdk openai @google/generative-ai

# Run adapter tests only
nvm use 22 && npm run test:orc -- --reporter=verbose adapters/adapters.test.mjs

# Full suite
nvm use 22 && npm run test:orc
```

```bash
# Confirm no tmux references remain in adapter source files
grep -r "spawnSync\|tmux\|tmuxTarget\|parseHandle" adapters/*.mjs
# Expected: no output
```

## Risk / Rollback

**Risk:** In-memory session state is lost if the coordinator process restarts. Sessions
must be re-initialized by calling `start()` again (the coordinator's `ensureSessionReady()`
already handles this when `session_handle` is stale).

**Rollback:** `git checkout adapters/` restores all three adapter files. SDK
packages remain installed but are unused. No state files are modified by this task.
