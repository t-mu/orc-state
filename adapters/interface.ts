/**
 * Provider Adapter Contract — PTY Session Edition
 *
 * All adapter factories must return an object implementing these five methods.
 * Provider-specific runtime state lives inside the adapter; the core only ever
 * sees `session_handle` and `provider_ref`.
 *
 * ─── Method signatures ────────────────────────────────────────────────────
 *
 * start(agentId, config) → Promise<{ session_handle, provider_ref }>
 *   Initialize a new provider CLI session for the agent.
 *   config: { system_prompt?, model?, working_directory?, env?, ...providerExtras }
 *   session_handle: opaque string used for subsequent operations.
 *                   Recommended format: "<provider>:<uuid>"
 *                   Example: "claude:3f2a...", "openai:7b1c...", "gemini:9e4d..."
 *   provider_ref:   adapter-internal metadata (opaque to orchestrator core).
 *
 * send(sessionHandle, text) → Promise<string>
 *   Send text to the agent session. In the PTY adapter this is fire-and-forget
 *   input delivery; worker lifecycle is reported through the `orc-run-*` CLI
 *   commands executed inside the worker session, not by parsing response text.
 *   Throws if sessionHandle is unknown or if delivery fails.
 *
 * attach(sessionHandle) → void  (synchronous)
 *   Print the most recent assistant response for this session to stdout.
 *   Used for debugging and log inspection. Must not throw if there are no
 *   messages yet — print "(no messages yet)" instead.
 *   Adapters that cannot retrieve history should print a descriptive notice.
 *
 * heartbeatProbe(sessionHandle) → Promise<boolean>
 *   Return true if the session is alive and reachable.
 *   Returns false (not throw) on any failure.
 *
 * stop(sessionHandle) → Promise<void>
 *   Tear down the session and release associated resources (e.g. clear
 *   conversation history from memory). No-op if session not found.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Throws if adapter is missing any required interface method.
 * Call this in tests and factory functions to catch misconfigured adapters.
 */
export function assertAdapterContract(adapter: unknown) {
  for (const method of ['start', 'send', 'attach', 'heartbeatProbe', 'stop']) {
    if (typeof (adapter as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`Adapter missing required method: ${method}`);
    }
  }
}

/**
 * Optional capability helper for adapters that can distinguish:
 * - "session process is alive"
 * - "this coordinator process can actively send to it"
 *
 * PTY adapters use this to avoid treating cross-process PID liveness as
 * writable session ownership.
 */
export function adapterOwnsSession(adapter: unknown, sessionHandle: string) {
  if (typeof (adapter as Record<string, (...args: unknown[]) => unknown>)?.ownsSession !== 'function') return true;
  return (adapter as Record<string, (...args: unknown[]) => unknown>).ownsSession(sessionHandle);
}

/**
 * Optional capability helper for adapters that can inspect recent session
 * output and surface a provider-level blocking prompt to the coordinator.
 */
export function adapterDetectInputBlock(adapter: unknown, sessionHandle: string) {
  if (typeof (adapter as Record<string, (...args: unknown[]) => unknown>)?.detectInputBlock !== 'function') return null;
  return (adapter as Record<string, (...args: unknown[]) => unknown>).detectInputBlock(sessionHandle);
}
