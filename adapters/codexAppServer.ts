/**
 * adapters/codexAppServer.ts — structured Codex runtime (task 203).
 *
 * Drives `codex app-server --listen stdio://` (JSON-RPC, one JSON object per
 * line) instead of the Codex terminal UI. Proven locally against Codex CLI
 * 0.163 under a ChatGPT login (docs/vnext-provider-protocols.md):
 * initialize → account/read → thread/start → turn/start → turn/completed, and
 * thread/resume from a second process.
 *
 * Billing guard: API-key routing variables are removed from the child
 * environment and `account/read` must report a ChatGPT account before any
 * thread starts; anything else is refused with UnverifiedAuthError.
 *
 * Capabilities declared (runtime.ts): structured events, command ACK and
 * resume. Steering, interrupt and approvals exist in the protocol but are not
 * yet proven end to end, so they are refused; approval requests from the
 * server are declined (the thread runs with approvalPolicy `never`).
 *
 * The app-server's stdio is owned by the coordinator process that launched it:
 * it does not survive a coordinator exit, and another process cannot write to
 * it. Another process (a restarted coordinator, `orc worker-remove`) sees the
 * session through its recorded PID and start time: alive but not writable, and
 * stoppable by signal.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, TARGET_REPO_ROOT } from '../lib/paths.ts';
import { stripAnsi } from '../lib/ansi.ts';
import { readProcessStart } from '../lib/processIdentity.ts';
import { currentSessionForAgent } from '../lib/sessionSupervisor.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { resolveBinary, resolveLaunchCwd, sandboxExtraWritableRoots } from './pty.ts';
import type { SessionInspection } from './interface.ts';
import {
  CapabilityRefusal,
  UnverifiedAuthError,
  withoutApiBillingEnv,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeEventType,
  type SubmitAck,
  type SubmitOptions,
} from './runtime.ts';

export const CODEX_APP_SERVER_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  structured_events: true,
  command_ack: true,
  resume: true,
  steer: false,
  interrupt: false,
  approvals: false,
});

const HANDLE_PREFIX = 'app:';
const OUTPUT_TAIL_BYTES = 8192;
const STOP_GRACE_MS = 5000;

/** Thread items that represent the agent acting rather than talking. */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration',
]);

/** Server → client approval requests, with the response that declines each. */
const APPROVAL_DECLINES: Record<string, unknown> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  execCommandApproval: { decision: 'denied' },
  applyPatchApproval: { decision: 'denied' },
};
/** Requests that also ask a human for something, but have no decline shape. */
const HUMAN_REQUESTS = new Set(['item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']);

/**
 * Appended to the worker bootstrap: on this runtime input is a turn, so a
 * worker that waits inside its turn would never see a follow-up.
 */
export const STRUCTURED_TURN_INSTRUCTIONS = [
  'STRUCTURED_RUNTIME',
  'You run as a structured app-server session, not a terminal. Each coordinator message arrives as a new turn,',
  'and only after your current turn has ended. Never wait or poll inside a turn for follow-up messages',
  '(FINALIZE_*, PR_REVIEW, nudges): after run-work-complete, end your turn; the follow-up starts your next turn.',
  'Blocking commands such as run-input-request are fine inside a turn.',
  'STRUCTURED_RUNTIME_END',
].join('\n');

export function isAppServerHandle(sessionHandle: string): boolean {
  return String(sessionHandle).startsWith(HANDLE_PREFIX);
}

function handshakeTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.ORC_CODEX_APP_SERVER_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

/**
 * Split a byte stream into JSON frames. Frames may arrive split across chunks
 * or several per chunk; a line that is not a JSON object is skipped (the
 * server may log to stdout) rather than poisoning the stream.
 */
export class JsonLineDecoder {
  private buffer = '';
  push(chunk: string): Record<string, unknown>[] {
    this.buffer += chunk;
    const frames: Record<string, unknown>[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frames.push(parsed as Record<string, unknown>);
      } catch { /* not a protocol frame */ }
    }
    return frames;
  }
}

interface PendingRpc {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface CodexSession {
  agentId: string;
  handle: string;
  child: ChildProcessWithoutNullStreams;
  pid: number;
  processStart: string | null;
  threadId: string | null;
  exited: boolean;
  nextId: number;
  pending: Map<number, PendingRpc>;
  /** Turn the provider is currently running, if any. */
  activeTurnId: string | null;
  /** A turn/start sent but not yet answered; its command claims the next turn. */
  submitting: { commandId: string | undefined } | null;
  turnCommands: Map<string, string | undefined>;
  finishedTurns: Set<string>;
}

function logPath(agentId: string): string { return join(STATE_DIR, 'pty-logs', `${agentId}.log`); }

function appendLog(agentId: string, text: string): void {
  try { appendFileSync(logPath(agentId), text); } catch { /* logging is best effort */ }
}

function stringField(value: unknown, key: string): string | undefined {
  const field = (value as Record<string, unknown> | null | undefined)?.[key];
  return typeof field === 'string' ? field : undefined;
}

export function createCodexAppServerAdapter({ provider = 'codex' }: { provider?: string } = {}) {
  if (provider !== 'codex') throw new CapabilityRefusal(provider, 'structured_events', 'no proven structured protocol');
  const sessions = new Map<string, CodexSession>();
  const listeners = new Set<RuntimeEventListener>();

  function emit(session: CodexSession, type: RuntimeEventType, providerEvent: string, meta: Record<string, unknown> = {}, turnId?: string): void {
    const event: RuntimeEvent = {
      type,
      session_handle: session.handle,
      agent_id: session.agentId,
      provider: 'codex',
      at: new Date().toISOString(),
      ...(turnId ? { turn_id: turnId } : {}),
      ...(turnId && session.turnCommands.get(turnId) ? { command_id: session.turnCommands.get(turnId)! } : {}),
      provider_event: providerEvent,
      provider_meta: { ...(session.threadId ? { thread_id: session.threadId } : {}), ...meta },
    };
    for (const listener of listeners) {
      try { listener(event); } catch { /* a listener must not break the protocol loop */ }
    }
  }

  function write(session: CodexSession, frame: Record<string, unknown>): void {
    if (session.exited || !session.child.stdin.writable) throw new Error(`app-server session ${session.handle} is not running`);
    session.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function rpc(session: CodexSession, method: string, params: Record<string, unknown>, timeoutMs = handshakeTimeoutMs()): Promise<Record<string, unknown>> {
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`app-server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      session.pending.set(id, {
        method,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        write(session, { id, method, params });
      } catch (error) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  /** Attribute a turn id to the submission in flight, the first time it is seen. */
  function claimTurn(session: CodexSession, turnId: string): void {
    if (!session.turnCommands.has(turnId) && session.submitting) session.turnCommands.set(turnId, session.submitting.commandId);
  }

  function onNotification(session: CodexSession, method: string, params: Record<string, unknown>): void {
    const turn = params.turn as { id?: unknown; status?: unknown } | undefined;
    const turnId = typeof turn?.id === 'string' ? turn.id : stringField(params, 'turnId');
    if (method === 'turn/started' && turnId) {
      claimTurn(session, turnId);
      // A late turn/started for a turn that already finished must not reopen it.
      if (!session.finishedTurns.has(turnId)) session.activeTurnId = turnId;
      appendLog(session.agentId, `\n[turn started ${turnId}]\n`);
      emit(session, 'turn_started', method, {}, turnId);
      return;
    }
    if (method === 'turn/completed' && turnId) {
      claimTurn(session, turnId);
      session.finishedTurns.add(turnId);
      if (session.activeTurnId === turnId) session.activeTurnId = null;
      const status = typeof turn?.status === 'string' ? turn.status : 'unknown';
      const type: RuntimeEventType = status === 'completed' ? 'turn_completed' : status === 'interrupted' ? 'turn_interrupted' : 'turn_failed';
      appendLog(session.agentId, `\n[turn ${status} ${turnId}]\n`);
      emit(session, type, method, { status }, turnId);
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const delta = stringField(params, 'delta');
      if (delta) appendLog(session.agentId, delta);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as { type?: unknown; id?: unknown; command?: unknown; status?: unknown } | undefined;
      const itemType = typeof item?.type === 'string' ? item.type : 'unknown';
      const meta = {
        item_type: itemType,
        ...(typeof item?.id === 'string' ? { item_id: item.id } : {}),
        ...(typeof item?.status === 'string' ? { item_status: item.status } : {}),
      };
      if (TOOL_ITEM_TYPES.has(itemType)) {
        if (method === 'item/started' && typeof item?.command === 'string') appendLog(session.agentId, `\n$ ${item.command}\n`);
        emit(session, method === 'item/started' ? 'tool_started' : 'tool_completed', method, meta, turnId);
      } else if (itemType === 'agentMessage' && method === 'item/completed') {
        appendLog(session.agentId, '\n');
        emit(session, 'message_completed', method, meta, turnId);
      }
      return;
    }
    if (method === 'error') {
      emit(session, 'provider_error', method, { will_retry: params.willRetry === true }, turnId);
    }
  }

  function onServerRequest(session: CodexSession, id: unknown, method: string, params: Record<string, unknown>): void {
    const turnId = stringField(params, 'turnId');
    const respond = (frame: Record<string, unknown>) => {
      try { write(session, { id, ...frame }); } catch { /* session is going away */ }
    };
    if (method in APPROVAL_DECLINES || HUMAN_REQUESTS.has(method)) {
      emit(session, 'approval_requested', method, {}, turnId);
      if (method in APPROVAL_DECLINES) respond({ result: APPROVAL_DECLINES[method] });
      else respond({ error: { code: -32601, message: 'orc-state does not bridge this request (approvals capability not supported)' } });
      emit(session, 'approval_refused', method, { reason: 'approvals capability not supported' }, turnId);
      appendLog(session.agentId, `\n[refused ${method}: approvals are not supported by this runtime]\n`);
      return;
    }
    respond({ error: { code: -32601, message: `orc-state does not handle ${method}` } });
  }

  function onFrame(session: CodexSession, frame: Record<string, unknown>): void {
    const method = typeof frame.method === 'string' ? frame.method : null;
    const hasId = frame.id !== undefined && frame.id !== null;
    if (method && hasId) return onServerRequest(session, frame.id, method, (frame.params ?? {}) as Record<string, unknown>);
    if (method) return onNotification(session, method, (frame.params ?? {}) as Record<string, unknown>);
    if (typeof frame.id !== 'number') return;
    const pending = session.pending.get(frame.id);
    if (!pending) return;
    session.pending.delete(frame.id);
    if (frame.error) {
      const error = frame.error as { code?: unknown; message?: unknown };
      const code = typeof error.code === 'number' || typeof error.code === 'string' ? error.code : 'unknown';
      const message = typeof error.message === 'string' ? error.message : 'no message';
      pending.reject(new Error(`app-server ${pending.method} failed (${code}): ${message}`));
    } else {
      pending.resolve((frame.result ?? {}) as Record<string, unknown>);
    }
  }

  function sandboxParams(config: Record<string, unknown>, cwd: string): Record<string, unknown> {
    if (config.read_only === true) return { sandbox: 'read-only' };
    if (config.execution_mode !== 'sandbox') return { sandbox: 'danger-full-access' };
    const roots = sandboxExtraWritableRoots({ readOnly: false, cwd, stateDir: STATE_DIR, gitRepoRoot: TARGET_REPO_ROOT });
    return {
      sandbox: 'workspace-write',
      ...(roots.length ? { config: { 'sandbox_workspace_write.writable_roots': roots } } : {}),
    };
  }

  async function verifySubscription(session: CodexSession): Promise<string> {
    const response = await rpc(session, 'account/read', { refreshToken: false });
    const account = response.account as { type?: unknown; planType?: unknown } | null | undefined;
    if (!account) throw new UnverifiedAuthError('codex', 'no Codex login; run `codex login` with a ChatGPT account');
    if (account.type !== 'chatgpt') {
      throw new UnverifiedAuthError('codex', `account type "${String(account.type)}" is not a ChatGPT subscription login; API-key billing is not a verified path`);
    }
    return typeof account.planType === 'string' ? account.planType : 'unknown';
  }

  async function start(agentId: string, config: Record<string, unknown> = {}) {
    const cwd = resolveLaunchCwd(config);
    const handle = `${HANDLE_PREFIX}${agentId}`;
    const existing = sessions.get(handle);
    if (existing) await stop(handle);
    mkdirSync(join(STATE_DIR, 'pty-logs'), { recursive: true });

    const env = withoutApiBillingEnv({ ...stripNestedProviderEnv(process.env), ...(config.env as Record<string, string> | undefined ?? {}) });
    const binary = resolveBinary(process.env.ORC_CODEX_BINARY ?? 'codex', env);
    const child = spawn(binary, ['app-server', '--listen', 'stdio://', '--enable', 'multi_agent'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const spawnError = new Promise<never>((_, reject) => child.once('error', reject));
    spawnError.catch(() => { /* surfaced through the handshake below */ });
    const session: CodexSession = {
      agentId, handle, child, pid: child.pid ?? -1, processStart: child.pid ? readProcessStart(child.pid) : null,
      threadId: null, exited: false, nextId: 1, pending: new Map(), activeTurnId: null, submitting: null,
      turnCommands: new Map(), finishedTurns: new Set(),
    };
    const decoder = new JsonLineDecoder();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { for (const frame of decoder.push(chunk)) onFrame(session, frame); });
    // stderr carries provider diagnostics; keep it out of the protocol and the log.
    child.stderr.resume();
    child.once('exit', (code, signal) => {
      session.exited = true;
      session.activeTurnId = null;
      for (const pending of session.pending.values()) pending.reject(new Error('app-server exited before responding'));
      session.pending.clear();
      appendLog(agentId, `\n[app-server exited code=${String(code)} signal=${String(signal)}]\n`);
      emit(session, 'session_exited', 'process/exit', { code, signal });
    });
    sessions.set(handle, session);
    appendLog(agentId, `\n[app-server starting in ${cwd}]\n`);

    try {
      await Promise.race([spawnError, (async () => {
        await rpc(session, 'initialize', { clientInfo: { name: 'orc_state', title: 'orc-state', version: '1' }, capabilities: null });
        write(session, { method: 'initialized', params: {} });
        const planType = await verifySubscription(session);
        const threadParams = {
          cwd,
          approvalPolicy: 'never',
          ...sandboxParams(config, cwd),
          ...(typeof config.model === 'string' && config.model ? { model: config.model } : {}),
          ...(typeof config.system_prompt === 'string' && config.system_prompt
            ? { developerInstructions: `${config.system_prompt}\n\n${STRUCTURED_TURN_INSTRUCTIONS}` }
            : {}),
        };
        const resumeThreadId = typeof config.resume_thread_id === 'string' && config.resume_thread_id ? config.resume_thread_id : null;
        const response = resumeThreadId
          ? await rpc(session, 'thread/resume', { threadId: resumeThreadId, excludeTurns: true, ...threadParams })
          : await rpc(session, 'thread/start', threadParams);
        const threadId = stringField(response.thread, 'id');
        if (!threadId) throw new Error('app-server did not return a thread id');
        session.threadId = threadId;
        emit(session, 'session_ready', resumeThreadId ? 'thread/resume' : 'thread/start', { plan_type: planType, resumed: Boolean(resumeThreadId) });
      })()]);
    } catch (error) {
      await stop(handle);
      throw error;
    }

    return {
      session_handle: handle,
      provider_ref: {
        provider: 'codex',
        transport: 'app-server',
        binary,
        pid: session.pid,
        process_start: session.processStart,
        thread_id: session.threadId,
        // The handshake proved the provider is ready; no terminal report-for-duty is needed.
        protocol_ready: true,
      },
    };
  }

  function liveSession(sessionHandle: string): CodexSession {
    const session = sessions.get(sessionHandle);
    if (!session || session.exited || !session.threadId) throw new Error(`No live app-server session for handle: ${sessionHandle}`);
    return session;
  }

  async function submit(sessionHandle: string, text: string, options: SubmitOptions = {}): Promise<SubmitAck> {
    const session = liveSession(sessionHandle);
    if (session.activeTurnId || session.submitting) {
      throw new CapabilityRefusal('codex', 'steer', `turn ${session.activeTurnId ?? '(starting)'} is still running`);
    }
    session.submitting = { commandId: options.commandId };
    try {
      appendLog(session.agentId, `\n[input${options.commandId ? ` ${options.commandId}` : ''}]\n${text}\n`);
      const response = await rpc(session, 'turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(options.commandId ? { clientUserMessageId: options.commandId } : {}),
      });
      const turnId = stringField(response.turn, 'id');
      if (!turnId) throw new Error('app-server accepted turn/start without a turn id');
      claimTurn(session, turnId);
      if (!session.finishedTurns.has(turnId)) session.activeTurnId = turnId;
      return { turn_id: turnId, mode: 'started' };
    } finally {
      session.submitting = null;
    }
  }

  /** The recorded app-server process of a session this process did not launch, if it is still that process. */
  function recordedProcess(sessionHandle: string): { pid: number; processStart: string } | null {
    if (!isAppServerHandle(sessionHandle)) return null;
    const record = currentSessionForAgent(STATE_DIR, sessionHandle.slice(HANDLE_PREFIX.length));
    if (record?.transport !== 'app-server' || record.process_pid == null || record.process_start == null) return null;
    if (readProcessStart(record.process_pid) !== record.process_start) return null;
    return { pid: record.process_pid, processStart: record.process_start };
  }

  async function stop(sessionHandle: string): Promise<void> {
    const session = sessions.get(sessionHandle);
    if (!session) {
      // Launched by another process (the coordinator): its stdio is not ours, but the process can be signalled.
      const recorded = recordedProcess(sessionHandle);
      if (recorded) process.kill(recorded.pid, 'SIGTERM');
      return;
    }
    sessions.delete(sessionHandle);
    if (session.exited) return;
    const exited = new Promise<void>((resolve) => session.child.once('exit', () => resolve()));
    session.child.stdin.end();
    session.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!session.exited) session.child.kill('SIGKILL'); }, STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  function getOutputTail(sessionHandle: string): string | null {
    if (!isAppServerHandle(sessionHandle)) return null;
    const path = logPath(sessionHandle.slice(HANDLE_PREFIX.length));
    try {
      if (!existsSync(path)) return '';
      return stripAnsi(readFileSync(path).subarray(-OUTPUT_TAIL_BYTES).toString('utf8')).trim();
    } catch {
      return null;
    }
  }

  function inspectSession(sessionHandle: string): SessionInspection {
    const session = sessions.get(sessionHandle);
    if (!session) {
      const recorded = recordedProcess(sessionHandle);
      if (recorded) {
        return {
          transport: 'app-server', alive: true, writable: false, pid: recorded.pid, processStart: recorded.processStart,
          reason: 'app-server session is owned by the coordinator process that launched it; stop it with orc worker-remove',
        };
      }
      return {
        transport: 'app-server', alive: false, writable: false, pid: null, processStart: null,
        reason: 'app-server session is not attached to this process; its stdio closes with the coordinator that launched it',
      };
    }
    const alive = !session.exited;
    return {
      transport: 'app-server', alive, writable: alive, pid: session.pid, processStart: session.processStart,
      ...(alive ? {} : { reason: 'app-server process exited' }),
    };
  }

  return {
    capabilities: CODEX_APP_SERVER_CAPABILITIES,
    start,
    submit,
    async send(sessionHandle: string, text: string): Promise<string> {
      await submit(sessionHandle, text);
      return '';
    },
    attach(sessionHandle: string): void {
      process.stdout.write(`${getOutputTail(sessionHandle) || '(no messages yet)'}\n`);
    },
    heartbeatProbe(sessionHandle: string): Promise<boolean> {
      return Promise.resolve(inspectSession(sessionHandle).alive);
    },
    stop,
    /** True while a turn is running or being started; new input would be refused. */
    turnActive(sessionHandle: string): boolean {
      const session = sessions.get(sessionHandle);
      return Boolean(session && !session.exited && (session.activeTurnId || session.submitting));
    },
    getOutputTail,
    onEvent(listener: RuntimeEventListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    ownsSession(sessionHandle: string): boolean {
      return inspectSession(sessionHandle).writable;
    },
    detectInputBlock(): null {
      return null;
    },
    inspectSession,
    survivesCoordinatorExit(): boolean {
      return false;
    },
    /** Test/diagnostic view of the provider thread behind a session. */
    threadId(sessionHandle: string): string | null {
      return sessions.get(sessionHandle)?.threadId ?? null;
    },
  };
}

export type CodexAppServerAdapter = ReturnType<typeof createCodexAppServerAdapter>;
