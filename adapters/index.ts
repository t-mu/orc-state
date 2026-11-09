import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, hookEventPath } from '../lib/paths.ts';
import { isSameProcess } from '../lib/processIdentity.ts';
import { taskLabelsPath } from '../hooks/orc-hook.ts';
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
 * Stops what a legacy `pty:` session left behind: the provider process the
 * old node-pty adapter recorded in `pty-pids/<agent>.pid` (it can outlive the
 * coordinator that spawned it) gets SIGTERM only when its pid and start time
 * still match, so a reused pid is never signalled; a bare-pid file cannot
 * prove identity and is only removed. The pid, hook-event and settings files go.
 */
function stopLegacyPtySession(sessionHandle: string): void {
  if (!sessionHandle.startsWith('pty:') || sessionHandle.length <= 4) return;
  const agentId = sessionHandle.slice(4);
  const pidFile = join(STATE_DIR, 'pty-pids', `${agentId}.pid`);
  try {
    const record = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: unknown; start?: unknown };
    if (typeof record?.pid === 'number' && typeof record.start === 'string' && isSameProcess({ pid: record.pid, start: record.start })) {
      process.kill(record.pid, 'SIGTERM');
    }
  } catch { /* no pid file, unreadable, or the process is already gone */ }
  const eventsFile = hookEventPath(agentId);
  for (const path of [pidFile, eventsFile, `${eventsFile}.processing`, taskLabelsPath(eventsFile), join(STATE_DIR, 'pty-settings', `${agentId}.json`)]) {
    try { unlinkSync(path); } catch { /* already gone or never created */ }
  }
}

/**
 * Sessions whose handle no adapter owns — chiefly `pty:` handles left in state
 * by an orc that still had the node-pty transport. Nothing can write to them,
 * so every call reports the session offline; the coordinator then clears it
 * and requeues the run (its exit was never observed), and `stop` ends a
 * provider process the old adapter left running (stopLegacyPtySession).
 */
const offlineAdapter = {
  send: (sessionHandle: string) => Promise.reject(new Error(`Session ${sessionHandle} is offline: orc runs terminal sessions in tmux only`)),
  attach: (sessionHandle: string) => { console.log(`(session ${sessionHandle} is offline: orc runs terminal sessions in tmux only)`); },
  heartbeatProbe: () => Promise.resolve(false),
  stop: (sessionHandle: string) => { stopLegacyPtySession(sessionHandle); return Promise.resolve(); },
  getOutputTail: () => null,
  ownsSession: () => false,
  detectInputBlock: () => null,
  // No exit was observed, so the run is requeued rather than resumed.
  exitStatus: () => null,
  survivesCoordinatorExit: () => false,
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
    adoptSession: (sessionHandle: string) => {
      const target = route(sessionHandle);
      return target === structured ? structured.adoptSession(sessionHandle) : Promise.resolve(target.inspectSession(sessionHandle));
    },
    survivesCoordinatorExit: (sessionHandle: string) => route(sessionHandle).survivesCoordinatorExit(sessionHandle),
    exitStatus: (sessionHandle: string) => route(sessionHandle).exitStatus(sessionHandle),
  };
  assertAdapterContract(adapter);
  return adapter;
}

export { createTmuxAdapter, assertAdapterContract, adapterGetOutputTail };
