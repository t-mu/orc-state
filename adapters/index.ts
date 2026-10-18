import { createPtyAdapter } from './pty.ts';
import { createTmuxAdapter, isTmuxAvailable } from './tmux.ts';
import { createCodexAppServerAdapter, isAppServerHandle } from './codexAppServer.ts';
import { assertAdapterContract, adapterGetOutputTail } from './interface.ts';
import { CLI_CAPABILITIES, CapabilityRefusal, type RuntimeEventListener, type SubmitOptions } from './runtime.ts';

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
 * Providers with a proven structured runtime (task 203). Others fall back to
 * their CLI explicitly: a `runtime: 'structured'` start request still launches
 * the CLI, and the session reports CLI capabilities plus the fallback reason.
 */
export const STRUCTURED_RUNTIME_PROVIDERS = new Set(['codex']);

/**
 * Create an adapter for the given provider.
 * New sessions start on the resolved transport (or the structured runtime when
 * the start config asks for `runtime: 'structured'`); every other call is
 * routed by the session handle prefix, so existing `pty:`, `tmux:` and `app:`
 * sessions keep working regardless of the current setting.
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
  const structured = STRUCTURED_RUNTIME_PROVIDERS.has(provider) ? createCodexAppServerAdapter({ provider }) : null;
  const route = (sessionHandle: string) => {
    if (structured && isAppServerHandle(sessionHandle)) return structured;
    return String(sessionHandle).startsWith('tmux:') ? tmux : pty;
  };
  const adapter = {
    start: async (agentId: string, config: Record<string, unknown> = {}) => {
      if (config.runtime === 'structured' && structured) return await structured.start(agentId, config);
      const transport = resolveSessionTransport();
      if (transport === 'tmux' && !isTmuxAvailable()) throw new Error('ORC_SESSION_TRANSPORT=tmux but tmux is not available');
      const result = await (transport === 'tmux' ? tmux : pty).start(agentId, config);
      if (config.runtime !== 'structured') return result;
      return {
        ...result,
        provider_ref: { ...(result.provider_ref as Record<string, unknown>), runtime_fallback: `no proven structured runtime for ${provider}; using the CLI` },
      };
    },
    capabilitiesFor: (sessionHandle: string) => (route(sessionHandle) === structured ? structured.capabilities : CLI_CAPABILITIES),
    submit: (sessionHandle: string, text: string, submitOptions?: SubmitOptions) => {
      if (route(sessionHandle) !== structured) return Promise.reject(new CapabilityRefusal(provider, 'command_ack', 'CLI sessions have no protocol acknowledgement'));
      return structured.submit(sessionHandle, text, submitOptions);
    },
    onEvent: (listener: RuntimeEventListener) => structured?.onEvent(listener) ?? (() => {}),
    turnActive: (sessionHandle: string) => route(sessionHandle) === structured && structured.turnActive(sessionHandle),
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
