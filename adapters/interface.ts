/**
 * Provider Adapter Contract
 *
 * All adapter factories must return an object implementing AdapterInterface.
 * Provider-specific runtime state lives inside the adapter; the core only ever
 * sees `session_handle` and `provider_ref`.
 *
 * ─── Method signatures ────────────────────────────────────────────────────
 *
 * start(agentId, config) → Promise<{ session_handle, provider_ref }>
 *   Initialize a new provider CLI session for the agent.
 *   config: { system_prompt?, model?, working_directory?, env?, ...providerExtras }
 *   working_directory: the provider process cwd; a task worker's assigned
 *     worktree. With `require_git_checkout: true` it must contain `.git`.
 *   session_handle: opaque string used for subsequent operations.
 *                   Recommended format: "<provider>:<uuid>"
 *                   Example: "claude:3f2a...", "openai:7b1c...", "gemini:9e4d..."
 *   provider_ref:   adapter-internal metadata (opaque to orchestrator core).
 *
 * send(sessionHandle, text) → Promise<string>
 *   Send text to the agent session. In the tmux adapter this is fire-and-forget
 *   input delivery; worker lifecycle is reported through the `orc-run-*` CLI
 *   commands executed inside the worker session, not by parsing response text.
 *   Throws if sessionHandle is unknown or if delivery fails.
 *
 * attach(sessionHandle) → void  (synchronous)
 *   Print a one-shot snapshot of the session's recent output to stdout, for
 *   non-interactive debugging. Must not throw if there are no messages yet —
 *   print "(no messages yet)" instead. Adapters that cannot retrieve history
 *   should print a descriptive notice. `orc attach` does not use this: it opens
 *   a real tmux client (see tmuxAttachCommand in adapters/tmux.ts).
 *
 * heartbeatProbe(sessionHandle) → Promise<boolean>
 *   Return true if the session is alive and reachable.
 *   Returns false (not throw) on any failure. The coordinator's liveness check
 *   prefers `inspectSession`, which can also report a probe that could not
 *   tell (`indeterminate`); see adapterProbeLiveness.
 *
 * stop(sessionHandle) → Promise<void>
 *   Tear down the session and release associated resources (e.g. clear
 *   conversation history from memory). No-op if session not found.
 *
 * getOutputTail(sessionHandle, maxBytes?) → string | null
 *   Return the last 8 KB (or maxBytes) of the session's output log, stripped of ANSI escape
 *   codes and trimmed of leading/trailing blank lines. Return '' if the log
 *   file does not exist. Return null on any other error (e.g. invalid handle).
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

/** What a supervisor can learn about a session without owning it. */
export interface SessionInspection {
  /** `legacy`: a handle no adapter runs, such as a `pty:` session from an older orc. */
  transport: 'tmux' | 'app-server' | 'legacy';
  alive: boolean;
  /** True when this process can deliver input to the session. */
  writable: boolean;
  pid: number | null;
  processStart: string | null;
  reason?: string;
  /**
   * True when the inspection itself failed (a transport error or timeout), so
   * `alive: false` is not evidence that the session exited.
   */
  indeterminate?: boolean;
}

/** One liveness probe: `indeterminate` means the probe could not tell. */
export type LivenessVerdict = 'alive' | 'dead' | 'indeterminate';

export interface LivenessProbe {
  verdict: LivenessVerdict;
  reason: string | null;
  pid: number | null;
}

/**
 * Probe a session's liveness, from `inspectSession` when the adapter has it,
 * else from `heartbeatProbe` (false is dead; a throw is indeterminate).
 */
export async function adapterProbeLiveness(adapter: AdapterInterface, sessionHandle: string): Promise<LivenessProbe> {
  const inspected = await adapterInspectSession(adapter, sessionHandle);
  if (inspected) {
    const verdict: LivenessVerdict = inspected.alive ? 'alive' : inspected.indeterminate ? 'indeterminate' : 'dead';
    return { verdict, reason: inspected.alive ? null : (inspected.reason ?? 'session not alive'), pid: inspected.pid };
  }
  try {
    const alive = await adapter.heartbeatProbe(sessionHandle);
    return { verdict: alive ? 'alive' : 'dead', reason: alive ? null : 'heartbeat probe failed', pid: null };
  } catch (error) {
    return { verdict: 'indeterminate', reason: `heartbeat probe error: ${(error as Error).message}`, pid: null };
  }
}

/**
 * How a session's provider process ended, as its transport observed it: an exit
 * code, or the signal that killed it. Null from `exitStatus` means not observed
 * (still running, or the session is gone without a record).
 */
export interface SessionExitStatus {
  code: number | null;
  signal: string | number | null;
}

export interface AdapterInterface {
  start(agentId: string, config: Record<string, unknown>): Promise<{ session_handle: string; provider_ref: unknown }>;
  send(sessionHandle: string, text: string): Promise<string>;
  attach(sessionHandle: string): void;
  heartbeatProbe(sessionHandle: string): Promise<boolean>;
  stop(sessionHandle: string): Promise<void>;
  getOutputTail(sessionHandle: string, maxBytes?: number): string | null;
}

/**
 * Throws if adapter is missing any required interface method.
 * Call this in tests and factory functions to catch misconfigured adapters.
 */
export function assertAdapterContract(adapter: unknown) {
  for (const method of ['start', 'send', 'attach', 'heartbeatProbe', 'stop', 'getOutputTail']) {
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
 * The tmux adapter reports ownership only for a live pane; a handle no
 * adapter owns (a legacy `pty:` session) is never owned.
 */
export function adapterOwnsSession(adapter: unknown, sessionHandle: string) {
  if (typeof (adapter as Record<string, (...args: unknown[]) => unknown>)?.ownsSession !== 'function') return true;
  return (adapter as Record<string, (...args: unknown[]) => unknown>).ownsSession(sessionHandle);
}

/**
 * Retrieve the last N bytes of a session's output log, stripped of ANSI codes.
 * Returns null if the adapter is not a conforming AdapterInterface (safety net
 * for callers that accept unvalidated adapter objects).
 */
export function adapterGetOutputTail(adapter: unknown, sessionHandle: string) {
  if (typeof (adapter as Record<string, (...args: unknown[]) => unknown>)?.getOutputTail !== 'function') return null;
  return (adapter as Record<string, (...args: unknown[]) => unknown>).getOutputTail(sessionHandle) as string | null;
}

/**
 * Optional capability helper for adapters that can inspect recent session
 * output and surface a provider-level blocking prompt to the coordinator.
 * `hookEvents` are the permission hook events the coordinator tick drained
 * for this session; adapters never read the hook-events file themselves.
 */
export function adapterDetectInputBlock(adapter: unknown, sessionHandle: string, hookEvents: Array<{ message?: string }> = []) {
  if (typeof (adapter as Record<string, (...args: unknown[]) => unknown>)?.detectInputBlock !== 'function') return null;
  return (adapter as Record<string, (...args: unknown[]) => unknown>).detectInputBlock(sessionHandle, hookEvents);
}

/**
 * Optional capability: inspect a session's liveness, writability and process
 * identity. Adapters without it are treated as owned when their probe passes.
 */
export async function adapterInspectSession(adapter: unknown, sessionHandle: string): Promise<SessionInspection | null> {
  const inspect = (adapter as { inspectSession?: (handle: string) => SessionInspection | Promise<SessionInspection> })?.inspectSession;
  if (typeof inspect !== 'function') return null;
  try {
    return await inspect.call(adapter, sessionHandle);
  } catch (error) {
    const transport = sessionHandle.startsWith('tmux:') ? 'tmux' : 'legacy';
    return { transport, alive: false, writable: false, pid: null, processStart: null, reason: (error as Error).message };
  }
}

/**
 * Optional capability: sessions whose process is supervised outside the
 * coordinator (tmux) survive a coordinator exit and must not be stopped by it.
 */
export function adapterSurvivesCoordinatorExit(adapter: unknown, sessionHandle: string): boolean {
  const survives = (adapter as { survivesCoordinatorExit?: (handle: string) => boolean })?.survivesCoordinatorExit;
  return typeof survives === 'function' ? survives.call(adapter, sessionHandle) : false;
}

/** Optional capability: the observed exit status of a session that ended, or null. */
export function adapterExitStatus(adapter: unknown, sessionHandle: string): SessionExitStatus | null {
  const exitStatus = (adapter as { exitStatus?: (handle: string) => SessionExitStatus | null })?.exitStatus;
  if (typeof exitStatus !== 'function') return null;
  try {
    return exitStatus.call(adapter, sessionHandle);
  } catch {
    return null;
  }
}
