import { createTmuxAdapter, checkTmux } from './tmux.ts';
import { createCodexAppServerAdapter, isAppServerHandle } from './codexAppServer.ts';
import { assertAdapterContract, adapterGetOutputTail, type SessionInspection } from './interface.ts';
import { CLI_CAPABILITIES, CapabilityRefusal, type RuntimeEventListener, type SubmitOptions } from './runtime.ts';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'gemini']);

/** tmux is checked once per process, on the first terminal session it starts. */
let tmuxUsable = false;

function assertTmuxUsable(): void {
  if (tmuxUsable) return;
  const check = checkTmux();
  if (!check.ok) throw new Error(`Cannot start a provider session: ${check.problem}`);
  tmuxUsable = true;
}

/**
 * Sessions whose handle no adapter owns — chiefly `pty:` handles left in state
 * by an orc that still had the node-pty transport. Their process (if any) died
 * with the coordinator that spawned it and nothing can write to it, so every
 * call reports the session offline; the coordinator then clears it and
 * requeues or resumes the run like any dead session.
 */
const offlineAdapter = {
  send: (sessionHandle: string) => Promise.reject(new Error(`Session ${sessionHandle} is offline: orc runs terminal sessions in tmux only`)),
  attach: (sessionHandle: string) => { console.log(`(session ${sessionHandle} is offline: orc runs terminal sessions in tmux only)`); },
  heartbeatProbe: () => Promise.resolve(false),
  stop: () => Promise.resolve(),
  getOutputTail: () => null,
  ownsSession: () => false,
  detectInputBlock: () => null,
  // No exit was observed, so the run is requeued rather than resumed.
  exitStatus: () => null,
  inspectSession: (): SessionInspection => ({
    transport: 'legacy', alive: false, writable: false, pid: null, processStart: null, reason: 'not a tmux or app-server session',
  }),
};

/**
 * Providers with a proven structured runtime (task 203). Others fall back to
 * their CLI explicitly: a `runtime: 'structured'` start request still launches
 * the CLI, and the session reports CLI capabilities plus the fallback reason.
 */
export const STRUCTURED_RUNTIME_PROVIDERS = new Set(['codex']);

/**
 * Create an adapter for the given provider.
 * New sessions start in tmux (or the structured runtime when the start config
 * asks for `runtime: 'structured'`); every other call is routed by the session
 * handle prefix: `app:` to the structured runtime, `tmux:` to tmux, and any
 * other handle (a `pty:` session from an older orc) reports offline.
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

  const tmux = createTmuxAdapter({ ...options, provider });
  const structured = STRUCTURED_RUNTIME_PROVIDERS.has(provider) ? createCodexAppServerAdapter({ provider }) : null;
  const route = (sessionHandle: string) => {
    if (structured && isAppServerHandle(sessionHandle)) return structured;
    return String(sessionHandle).startsWith('tmux:') ? tmux : offlineAdapter;
  };
  const adapter = {
    start: async (agentId: string, config: Record<string, unknown> = {}) => {
      if (config.runtime === 'structured' && structured) return await structured.start(agentId, config);
      assertTmuxUsable();
      const result = await tmux.start(agentId, config);
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
    getOutputTail: (sessionHandle: string, maxBytes?: number) => route(sessionHandle).getOutputTail(sessionHandle, maxBytes),
    ownsSession: (sessionHandle: string) => route(sessionHandle).ownsSession(sessionHandle),
    detectInputBlock: (sessionHandle: string, hookEvents?: Array<{ message?: string }>) => route(sessionHandle).detectInputBlock(sessionHandle, hookEvents),
    inspectSession: (sessionHandle: string) => route(sessionHandle).inspectSession(sessionHandle),
    survivesCoordinatorExit: (sessionHandle: string) => tmux.survivesCoordinatorExit(sessionHandle),
    exitStatus: (sessionHandle: string) => route(sessionHandle).exitStatus(sessionHandle),
  };
  assertAdapterContract(adapter);
  return adapter;
}

export { createTmuxAdapter, assertAdapterContract, adapterGetOutputTail };
