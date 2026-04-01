# Writing Custom Provider Adapters

An adapter bridges orc-state to a specific AI provider's CLI. The orchestrator
core never talks to provider binaries directly -- it calls adapter methods
(`start`, `send`, `stop`, etc.) and the adapter handles the provider-specific
details. This makes orc-state provider-agnostic: same orchestration logic,
any model backend.

The built-in PTY adapter (`adapters/pty.ts`) drives Claude, Codex, and Gemini
by spawning their CLI binaries as PTY child processes. If you need to integrate
a different provider or a non-PTY transport (HTTP API, Docker container, remote
SSH session), you write a custom adapter.

## The Adapter Interface

Every adapter must implement `AdapterInterface` from `adapters/interface.ts`:

```ts
interface AdapterInterface {
  start(agentId: string, config: Record<string, unknown>):
    Promise<{ session_handle: string; provider_ref: unknown }>;

  send(sessionHandle: string, text: string): Promise<string>;

  attach(sessionHandle: string): void;

  heartbeatProbe(sessionHandle: string): Promise<boolean>;

  stop(sessionHandle: string): Promise<void>;

  getOutputTail(sessionHandle: string): string | null;
}
```

### Method reference

**`start(agentId, config)`** -- Initialize a new session for the given agent.

- `config` may contain `system_prompt`, `model`, `working_directory`, `env`, and
  any provider-specific extras.
- Returns `{ session_handle, provider_ref }`.
  - `session_handle`: an opaque string the orchestrator passes back to all
    subsequent calls. Recommended format: `"<provider>:<id>"` (e.g.
    `"myapi:3f2a..."`).
  - `provider_ref`: adapter-internal metadata. The orchestrator stores it but
    never inspects it.

**`send(sessionHandle, text)`** -- Deliver text input to a running session.

- Returns a string (can be empty). The orchestrator does not parse the return
  value -- worker lifecycle is reported through `orc run-*` CLI commands executed
  inside the worker session.
- Throws if the session handle is unknown or delivery fails.

**`attach(sessionHandle)`** -- Print recent session output to stdout (synchronous).

- Used for debugging and log inspection (`orc attach <id>`).
- Must not throw if there are no messages yet -- print `"(no messages yet)"`.

**`heartbeatProbe(sessionHandle)`** -- Check whether a session is alive.

- Returns `true` if reachable, `false` otherwise.
- Must never throw -- return `false` on any error.

**`stop(sessionHandle)`** -- Tear down the session and release resources.

- No-op if the session is not found (do not throw).

**`getOutputTail(sessionHandle)`** -- Return the last ~8 KB of session output.

- Strip ANSI escape codes and trim leading/trailing blank lines.
- Return `''` if no output log exists.
- Return `null` on any other error (e.g. invalid handle).

## Optional capabilities

These are not part of the required interface but are recognized by the
orchestrator when present:

**`ownsSession(sessionHandle)`** -- Return `true` if this process owns the
session (useful for PTY adapters that distinguish "process is alive" from "I
can write to it"). If absent, the orchestrator assumes ownership.

**`detectInputBlock(sessionHandle)`** -- Scan recent output for provider-level
blocking prompts (permission dialogs, quota errors). Return the blocking line
as a string, or `null` if none detected.

## Creating an adapter

Use the `createAdapter` factory for built-in providers:

```ts
import { createAdapter } from 'orc-state';

const adapter = createAdapter('claude');
```

For a custom adapter, write a factory function that returns an object
implementing all six required methods, then validate it with
`assertAdapterContract`.

## Validating with assertAdapterContract

`assertAdapterContract` checks that an adapter object has all required methods.
It throws if any are missing. Call it in your factory function and in tests.

```ts
import { assertAdapterContract } from 'orc-state';

const adapter = createMyAdapter();
assertAdapterContract(adapter); // throws if missing start, send, attach, etc.
```

## Example: minimal custom adapter

```ts
import { assertAdapterContract } from 'orc-state';

function createHttpAdapter(baseUrl: string) {
  const sessions = new Map<string, { id: string }>();

  const adapter = {
    async start(agentId: string, config: Record<string, unknown>) {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, model: config.model }),
      });
      const { sessionId } = await res.json();
      const handle = `http:${sessionId}`;
      sessions.set(handle, { id: sessionId });

      return {
        session_handle: handle,
        provider_ref: { sessionId, baseUrl },
      };
    },

    async send(sessionHandle: string, text: string) {
      const session = sessions.get(sessionHandle);
      if (!session) throw new Error(`Unknown session: ${sessionHandle}`);
      await fetch(`${baseUrl}/sessions/${session.id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return '';
    },

    attach(sessionHandle: string) {
      const session = sessions.get(sessionHandle);
      if (!session) {
        console.log('(no messages yet)');
        return;
      }
      // In a real adapter, fetch and print recent output.
      console.log(`(session ${session.id} -- use getOutputTail for log data)`);
    },

    async heartbeatProbe(sessionHandle: string) {
      try {
        const session = sessions.get(sessionHandle);
        if (!session) return false;
        const res = await fetch(`${baseUrl}/sessions/${session.id}/health`);
        return res.ok;
      } catch {
        return false;
      }
    },

    async stop(sessionHandle: string) {
      const session = sessions.get(sessionHandle);
      if (!session) return;
      try {
        await fetch(`${baseUrl}/sessions/${session.id}`, { method: 'DELETE' });
      } catch { /* best effort */ }
      sessions.delete(sessionHandle);
    },

    getOutputTail(sessionHandle: string) {
      const session = sessions.get(sessionHandle);
      if (!session) return null;
      // Return recent output. In a real adapter, fetch from the server
      // or read from a local log buffer.
      return '';
    },
  };

  assertAdapterContract(adapter);
  return adapter;
}
```

Key points:

- Session handles are opaque strings. Pick a prefix that identifies your
  transport (e.g. `http:`, `docker:`, `ssh:`).
- `heartbeatProbe` and `stop` must never throw. Swallow errors and return
  gracefully.
- `attach` is synchronous. If your backend requires async fetching, buffer
  output locally and print from the buffer.
- Call `assertAdapterContract` at the end of your factory to catch mistakes
  early.
