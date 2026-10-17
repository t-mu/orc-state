import { createPtyAdapter } from './pty.ts';
import { createTmuxAdapter, isTmuxAvailable } from './tmux.ts';
import { assertAdapterContract, adapterGetOutputTail } from './interface.ts';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'gemini']);

export type SessionTransport = 'pty' | 'tmux';

let detectedTransport: SessionTransport | null = null;

/**
 * ORC_SESSION_TRANSPORT selects how new sessions launch: `auto` (default)
 * uses tmux when the binary is available so sessions survive a coordinator
 * restart, otherwise node-pty; `tmux` or `pty` forces one.
 */
export function resolveSessionTransport(): SessionTransport {
  const configured = process.env.ORC_SESSION_TRANSPORT ?? 'auto';
  if (configured === 'pty' || configured === 'tmux') return configured;
  if (configured !== 'auto') throw new Error(`Invalid ORC_SESSION_TRANSPORT: ${configured} (expected auto, tmux or pty)`);
  detectedTransport ??= isTmuxAvailable() ? 'tmux' : 'pty';
  return detectedTransport;
}

/**
 * Create an adapter for the given provider.
 * New sessions start on the resolved transport; every other call is routed by
 * the session handle prefix, so existing `pty:` and `tmux:` sessions keep
 * working regardless of the current setting.
 *
 * @param provider - 'claude' | 'codex' | 'gemini'
 * @param options
 * @returns adapter object
 */
export function createAdapter(provider: string, options: Record<string, unknown> = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown provider: ${provider}. Supported: ${[...SUPPORTED_PROVIDERS].join(', ')}`,
    );
  }

  const pty = createPtyAdapter({ ...options, provider });
  const tmux = createTmuxAdapter({ ...options, provider });
  const route = (sessionHandle: string) => (String(sessionHandle).startsWith('tmux:') ? tmux : pty);
  const adapter = {
    start: async (agentId: string, config: Record<string, unknown> = {}) => {
      const transport = resolveSessionTransport();
      if (transport === 'tmux' && !isTmuxAvailable()) throw new Error('ORC_SESSION_TRANSPORT=tmux but tmux is not available');
      return await (transport === 'tmux' ? tmux : pty).start(agentId, config);
    },
    send: (sessionHandle: string, text: string) => route(sessionHandle).send(sessionHandle, text),
    attach: (sessionHandle: string) => route(sessionHandle).attach(sessionHandle),
    heartbeatProbe: (sessionHandle: string) => route(sessionHandle).heartbeatProbe(sessionHandle),
    stop: (sessionHandle: string) => route(sessionHandle).stop(sessionHandle),
    getOutputTail: (sessionHandle: string) => route(sessionHandle).getOutputTail(sessionHandle),
    ownsSession: (sessionHandle: string) => route(sessionHandle).ownsSession(sessionHandle),
    detectInputBlock: (sessionHandle: string) => route(sessionHandle).detectInputBlock(sessionHandle),
    inspectSession: (sessionHandle: string) => route(sessionHandle).inspectSession(sessionHandle),
    survivesCoordinatorExit: (sessionHandle: string) => tmux.survivesCoordinatorExit(sessionHandle),
  };
  assertAdapterContract(adapter);
  return adapter;
}

export { createPtyAdapter, createTmuxAdapter, assertAdapterContract, adapterGetOutputTail };
