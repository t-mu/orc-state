/**
 * adapters/codexAppServer.ts — structured Codex runtime (task 203).
 *
 * Drives `codex app-server` (JSON-RPC) instead of the Codex terminal UI.
 * Proven locally against Codex CLI 0.163 under a ChatGPT login
 * (docs/configuration.md "Worker Runtimes"): initialize → account/read →
 * thread/start → turn/start → turn/completed, thread/resume from a second
 * process, and reattaching a running turn from a second client.
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
 * The app-server runs detached from the coordinator, listening on a Unix
 * socket under the state directory (`app-server/<agent>.sock`, WebSocket
 * framing), so it survives a coordinator restart: the next coordinator adopts
 * it (`adoptSession`) after checking the recorded PID and start time, and
 * reattaches its thread. A small shell wrapper records the provider's exit
 * status in `app-server/<agent>.exit`, so the exit is known whichever process
 * is attached, or none; `app-server/<agent>.turn.json` names the command that
 * started the latest turn (docs/adapters.md "Codex app-server sessions"). Another process that does not adopt the session (`orc
 * worker-remove`) sees it alive but not writable, and stops it by signal.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR, TARGET_REPO_ROOT } from '../lib/paths.ts';
import { stripAnsi } from '../lib/ansi.ts';
import { isPidAlive, isSameProcess, readProcessStart } from '../lib/processIdentity.ts';
import { currentSessionForAgent } from '../lib/sessionSupervisor.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { controlSocketOf, isolatedMcpArgs, resolveBinary, resolveLaunchCwd, sandboxExtraWritableRoots, sandboxNetworkOf } from './providerLaunch.ts';
import type { SessionExitStatus, SessionInspection } from './interface.ts';
import { connectUnixWebSocket, type UnixWebSocket } from './unixWebSocket.ts';
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

interface PendingRpc {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface CodexSession {
  agentId: string;
  handle: string;
  /** The wrapper shell that owns the app-server: the recorded identity and process-group leader. */
  pid: number;
  processStart: string | null;
  threadId: string | null;
  socket: UnixWebSocket | null;
  /** True while the socket is open; the provider's exit itself is recorded on disk (`exitStatus`). */
  connected: boolean;
  /** Set by `stop` and `detach`: a close this process asked for is not a provider exit. */
  closing: boolean;
  nextId: number;
  pending: Map<number, PendingRpc>;
  /** Turn the provider is currently running, if any. */
  activeTurnId: string | null;
  /** A turn/start sent but not yet answered; its command claims the next turn. */
  submitting: { commandId: string | undefined } | null;
  turnCommands: Map<string, string | undefined>;
  finishedTurns: Set<string>;
}

function appServerDir(): string { return join(STATE_DIR, 'app-server'); }
/** Codex replaces a socket path too long for AF_UNIX with a symlink to a short one; connect through realpath. */
function socketPath(agentId: string): string { return join(appServerDir(), `${agentId}.sock`); }
function exitPath(agentId: string): string { return join(appServerDir(), `${agentId}.exit`); }
/** The latest turn and the command that started it, for a coordinator that adopts the session later. */
function turnPath(agentId: string): string { return join(appServerDir(), `${agentId}.turn.json`); }

function persistTurn(agentId: string, turnId: string, commandId: string | undefined): void {
  try {
    const path = turnPath(agentId);
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ turn_id: turnId, command_id: commandId ?? null })}\n`);
    renameSync(`${path}.tmp`, path);
  } catch { /* best effort: the provider's own record (clientUserMessageId) is the fallback */ }
}

function persistedTurn(agentId: string): { turn_id: string; command_id: string | null } | null {
  try {
    const parsed = JSON.parse(readFileSync(turnPath(agentId), 'utf8')) as { turn_id?: unknown; command_id?: unknown };
    return typeof parsed.turn_id === 'string' ? { turn_id: parsed.turn_id, command_id: typeof parsed.command_id === 'string' ? parsed.command_id : null } : null;
  } catch {
    return null;
  }
}

/**
 * Runs the provider and records its exit status: the code, or 128 + signal.
 * `exec` is not used, so the shell outlives the provider to write the file.
 */
const EXIT_RECORDER = 'exit_file=$1; shift; "$@"; status=$?; printf \'%s\\n\' "$status" > "$exit_file.tmp" && mv -f "$exit_file.tmp" "$exit_file"';

const SIGNAL_NAMES = new Map(Object.entries(osConstants.signals).map(([name, number]) => [number, name]));

/** The recorded exit of an agent's app-server, or null while it runs (or was stopped with its wrapper). */
export function readAppServerExit(agentId: string): SessionExitStatus | null {
  let raw: string;
  try { raw = readFileSync(exitPath(agentId), 'utf8').trim(); } catch { return null; }
  const status = Number.parseInt(raw, 10);
  if (!Number.isInteger(status)) return { code: null, signal: null };
  if (status > 128 && SIGNAL_NAMES.has(status - 128)) return { code: null, signal: SIGNAL_NAMES.get(status - 128)! };
  return { code: status, signal: null };
}

function describeExit(status: SessionExitStatus): string {
  return status.signal != null ? `signal ${String(status.signal)}` : `code ${String(status.code)}`;
}

function logPath(agentId: string): string { return join(STATE_DIR, 'pty-logs', `${agentId}.log`); }

function appendLog(agentId: string, text: string): void {
  try { appendFileSync(logPath(agentId), text); } catch { /* logging is best effort */ }
}

function stringField(value: unknown, key: string): string | undefined {
  const field = (value as Record<string, unknown> | null | undefined)?.[key];
  return typeof field === 'string' ? field : undefined;
}

/** Thread sandbox parameters for the structured runtime; the same grants as the CLI runtime. */
export function codexAppServerSandboxParams(config: Record<string, unknown>, cwd: string): Record<string, unknown> {
  if (config.read_only === true) return { sandbox: 'read-only' };
  if (config.execution_mode !== 'sandbox') return { sandbox: 'danger-full-access' };
  const controlSocket = controlSocketOf(config);
  const roots = sandboxExtraWritableRoots({ readOnly: false, cwd, stateDir: STATE_DIR, gitRepoRoot: TARGET_REPO_ROOT, controlSocket });
  const settings: Record<string, unknown> = {
    ...(roots.length ? { 'sandbox_workspace_write.writable_roots': roots } : {}),
    // Opt-in: a project worker reaches its coordinator's socket only with network access (see codexSandboxNetworkArgs).
    ...(controlSocket && sandboxNetworkOf(config) === 'open' ? { 'sandbox_workspace_write.network_access': true } : {}),
  };
  return {
    sandbox: 'workspace-write',
    ...(Object.keys(settings).length ? { config: settings } : {}),
  };
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
    if (!session.connected || !session.socket) throw new Error(`app-server session ${session.handle} is not running`);
    session.socket.send(JSON.stringify(frame));
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
    if (session.turnCommands.has(turnId) || !session.submitting) return;
    session.turnCommands.set(turnId, session.submitting.commandId);
    persistTurn(session.agentId, turnId, session.submitting.commandId);
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

  async function verifySubscription(session: CodexSession): Promise<string> {
    const response = await rpc(session, 'account/read', { refreshToken: false });
    const account = response.account as { type?: unknown; planType?: unknown } | null | undefined;
    if (!account) throw new UnverifiedAuthError('codex', 'no Codex login; run `codex login` with a ChatGPT account');
    if (account.type !== 'chatgpt') {
      throw new UnverifiedAuthError('codex', `account type "${String(account.type)}" is not a ChatGPT subscription login; API-key billing is not a verified path`);
    }
    return typeof account.planType === 'string' ? account.planType : 'unknown';
  }

  /** Wire a connected socket to a session: frames in, and a close that is not ours reported as an exit. */
  async function connect(session: CodexSession, timeoutMs: number): Promise<void> {
    session.closing = false;
    session.socket = await connectUnixWebSocket(realpathSync(socketPath(session.agentId)), {
      timeoutMs,
      onMessage: (text) => {
        let frame: unknown;
        try { frame = JSON.parse(text); } catch { return; /* not a protocol frame */ }
        if (frame && typeof frame === 'object' && !Array.isArray(frame)) onFrame(session, frame as Record<string, unknown>);
      },
      onClose: () => { void onDisconnect(session); },
    });
    session.connected = true;
  }

  async function onDisconnect(session: CodexSession): Promise<void> {
    session.connected = false;
    session.socket = null;
    session.activeTurnId = null;
    for (const pending of session.pending.values()) pending.reject(new Error('app-server connection closed before responding'));
    session.pending.clear();
    if (session.closing) return;
    // The wrapper writes the exit status just after the provider closes the socket.
    const deadline = Date.now() + 2_000;
    let status = readAppServerExit(session.agentId);
    while (!status && Date.now() < deadline && isPidAlive(session.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = readAppServerExit(session.agentId);
    }
    appendLog(session.agentId, `\n[app-server exited ${status ? describeExit(status) : '(status unknown)'}]\n`);
    emit(session, 'session_exited', 'process/exit', { code: status?.code ?? null, signal: status?.signal ?? null });
  }

  /** Wait for the detached app-server to listen, then connect; fail early if it exits first. */
  async function connectWhenListening(session: CodexSession): Promise<void> {
    const timeoutMs = handshakeTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      const exit = readAppServerExit(session.agentId);
      if (exit) throw new Error(`app-server exited before listening (${describeExit(exit)})`);
      if (existsSync(socketPath(session.agentId))) {
        try {
          await connect(session, Math.max(1, deadline - Date.now()));
          return;
        } catch (error) {
          lastError = error as Error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`app-server did not listen on ${socketPath(session.agentId)} within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
  }

  function newSession(agentId: string, pid: number, processStart: string | null, threadId: string | null): CodexSession {
    return {
      agentId, handle: `${HANDLE_PREFIX}${agentId}`, pid, processStart, threadId, socket: null, connected: false, closing: false,
      nextId: 1, pending: new Map(), activeTurnId: null, submitting: null, turnCommands: new Map(), finishedTurns: new Set(),
    };
  }

  async function start(agentId: string, config: Record<string, unknown> = {}) {
    const cwd = resolveLaunchCwd(config);
    const handle = `${HANDLE_PREFIX}${agentId}`;
    if (sessions.has(handle) || recordedProcess(handle)) await stop(handle);
    mkdirSync(join(STATE_DIR, 'pty-logs'), { recursive: true });
    mkdirSync(appServerDir(), { recursive: true });
    rmSync(socketPath(agentId), { force: true });
    rmSync(exitPath(agentId), { force: true });
    rmSync(turnPath(agentId), { force: true });

    const env = withoutApiBillingEnv({ ...stripNestedProviderEnv(process.env), ...(config.env as Record<string, string> | undefined ?? {}) });
    const binary = resolveBinary(process.env.ORC_CODEX_BINARY ?? 'codex', env);
    const args = ['app-server', '--listen', `unix://${socketPath(agentId)}`, '--enable', 'multi_agent', ...isolatedMcpArgs('codex')];
    // Detached into its own session and process group, so it outlives this coordinator; `stop` signals the group.
    const child = spawn('/bin/sh', ['-c', EXIT_RECORDER, 'orc-codex-app-server', exitPath(agentId), binary, ...args], {
      cwd, env, detached: true, stdio: 'ignore',
    });
    child.unref();
    const spawnError = new Promise<never>((_, reject) => child.once('error', reject));
    spawnError.catch(() => { /* surfaced through the handshake below */ });
    const session = newSession(agentId, child.pid ?? -1, child.pid ? readProcessStart(child.pid) : null, null);
    sessions.set(handle, session);
    appendLog(agentId, `\n[app-server starting in ${cwd}]\n`);

    try {
      await Promise.race([spawnError, (async () => {
        await connectWhenListening(session);
        await rpc(session, 'initialize', { clientInfo: { name: 'orc_state', title: 'orc-state', version: '1' }, capabilities: null });
        write(session, { method: 'initialized', params: {} });
        const planType = await verifySubscription(session);
        const threadParams = {
          cwd,
          approvalPolicy: 'never',
          ...codexAppServerSandboxParams(config, cwd),
          ...(typeof config.model === 'string' && config.model ? { model: config.model } : {}),
          ...(typeof config.system_prompt === 'string' && config.system_prompt
            ? { developerInstructions: `${config.system_prompt}\n\n${STRUCTURED_TURN_INSTRUCTIONS}` }
            : {}),
        };
        // `resume_conversation_id` is the provider-neutral key the session resume uses (lib/sessionResume.ts).
        const resumeRaw = config.resume_conversation_id ?? config.resume_thread_id;
        const resumeThreadId = typeof resumeRaw === 'string' && resumeRaw ? resumeRaw : null;
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

  /**
   * Reattach a thread this process did not drive and recover its last turn.
   * The provider keeps the turns; the command that started the last one is
   * the persisted turn record (`<agent>.turn.json`), or the turn's user
   * message `clientId` (`clientUserMessageId`). A turn that finished while no
   * coordinator was attached is reported now, so its command's ACK advances;
   * a running one keeps the session busy. Codex cannot list the turns of a
   * thread whose history is not written yet (`list_turns is not supported
   * yet` just after a turn starts), so the full resume is the fallback.
   */
  async function reattachThread(session: CodexSession): Promise<void> {
    type Turn = { id?: unknown; status?: unknown; items?: unknown };
    const persisted = persistedTurn(session.agentId);
    // Codex replays the running turn's turn/started during the resume: attribute it already.
    if (persisted?.command_id) session.turnCommands.set(persisted.turn_id, persisted.command_id);
    let last: Turn | undefined;
    try {
      const response = await rpc(session, 'thread/resume', { threadId: session.threadId, excludeTurns: true });
      if (stringField(response.thread, 'id') !== session.threadId) throw new Error('thread/resume returned a different thread');
      const listed = await rpc(session, 'thread/turns/list', { threadId: session.threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
      last = (Array.isArray(listed.data) ? listed.data[0] : undefined) as Turn | undefined;
    } catch {
      const response = await rpc(session, 'thread/resume', { threadId: session.threadId });
      if (stringField(response.thread, 'id') !== session.threadId) throw new Error('thread/resume returned a different thread');
      const turns = (response.thread as { turns?: unknown } | undefined)?.turns;
      last = (Array.isArray(turns) ? turns.at(-1) : undefined) as Turn | undefined;
    }
    if (!last || typeof last.id !== 'string') return;
    const items = Array.isArray(last.items) ? last.items as Array<{ type?: unknown; clientId?: unknown }> : [];
    const clientId = items.find((item) => item.type === 'userMessage' && typeof item.clientId === 'string')?.clientId as string | undefined;
    session.turnCommands.set(last.id, (persisted?.turn_id === last.id ? persisted.command_id : null) ?? clientId);
    if (last.status === 'inProgress') {
      session.activeTurnId = last.id;
      return;
    }
    onNotification(session, 'turn/completed', { threadId: session.threadId, turn: { id: last.id, status: last.status } });
  }

  /** The recorded session of an app-server handle, with its process identity, or null. */
  function recordedSession(sessionHandle: string) {
    if (!isAppServerHandle(sessionHandle)) return null;
    const record = currentSessionForAgent(STATE_DIR, sessionHandle.slice(HANDLE_PREFIX.length));
    if (record?.transport !== 'app-server' || record.process_pid == null || record.process_start == null) return null;
    return { ...record, process_pid: record.process_pid, process_start: record.process_start };
  }

  /**
   * Take over a live app-server another coordinator launched (a coordinator
   * restart): check the recorded PID and start time, reconnect to its socket
   * and reattach its thread. Returns the inspection the supervisor classifies:
   * writable once adopted, otherwise not alive with the reason, so the run
   * takes the dead-session path (resume or requeue). A live app-server that
   * cannot be reattached is stopped, so it cannot keep working unsupervised.
   */
  async function adoptSession(sessionHandle: string): Promise<SessionInspection> {
    const attached = sessions.get(sessionHandle);
    if (attached?.connected || !isAppServerHandle(sessionHandle)) return inspectSession(sessionHandle);
    const agentId = sessionHandle.slice(HANDLE_PREFIX.length);
    const record = recordedSession(sessionHandle);
    const gone = (reason: string): SessionInspection => ({
      transport: 'app-server', alive: false, writable: false, pid: record?.process_pid ?? null, processStart: record?.process_start ?? null, reason,
    });
    if (!record) return gone('no recorded app-server process identity to adopt');
    if (!isSameProcess({ pid: record.process_pid, start: record.process_start })) {
      const exit = readAppServerExit(agentId);
      if (exit) return gone(`app-server exited (${describeExit(exit)}) while no coordinator was attached`);
      return gone(isPidAlive(record.process_pid)
        ? `app-server is gone: PID ${record.process_pid} now belongs to another process (start time does not match)`
        : `app-server process ${record.process_pid} is gone`);
    }
    if (!record.provider_conversation_id) {
      await stop(sessionHandle);
      return gone('no recorded provider thread to reattach; stopped the app-server');
    }
    const session = newSession(agentId, record.process_pid, record.process_start, record.provider_conversation_id);
    sessions.set(sessionHandle, session);
    try {
      await connect(session, handshakeTimeoutMs());
      await rpc(session, 'initialize', { clientInfo: { name: 'orc_state', title: 'orc-state', version: '1' }, capabilities: null });
      write(session, { method: 'initialized', params: {} });
      await reattachThread(session);
    } catch (error) {
      await stop(sessionHandle);
      return gone(`could not reattach the live app-server (${(error as Error).message}); stopped it`);
    }
    appendLog(agentId, `\n[app-server adopted by coordinator pid ${process.pid}]\n`);
    emit(session, 'session_ready', 'thread/resume', { adopted: true, resumed: true });
    return inspectSession(sessionHandle);
  }

  function liveSession(sessionHandle: string): CodexSession {
    const session = sessions.get(sessionHandle);
    if (!session?.connected || !session.threadId) throw new Error(`No live app-server session for handle: ${sessionHandle}`);
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

  /** The recorded app-server process of a session this process has not attached, if it is still that process. */
  function recordedProcess(sessionHandle: string): { pid: number; processStart: string } | null {
    const record = recordedSession(sessionHandle);
    if (!record || !isSameProcess({ pid: record.process_pid, start: record.process_start })) return null;
    return { pid: record.process_pid, processStart: record.process_start };
  }

  /** SIGTERM the wrapper's process group (wrapper and provider), then SIGKILL it after a grace period. */
  async function signalGroup(pid: number, processStart: string | null): Promise<void> {
    const same = () => (processStart ? isSameProcess({ pid, start: processStart }) : isPidAlive(pid));
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* group already gone */ } };
    if (pid <= 0 || !same()) return;
    kill('SIGTERM');
    const deadline = Date.now() + STOP_GRACE_MS;
    while (same() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (same()) kill('SIGKILL');
  }

  async function stop(sessionHandle: string): Promise<void> {
    const session = sessions.get(sessionHandle);
    if (!session) {
      // Launched or adopted by another process (the coordinator): signal it through its recorded identity.
      const recorded = recordedProcess(sessionHandle);
      if (recorded) await signalGroup(recorded.pid, recorded.processStart);
      return;
    }
    sessions.delete(sessionHandle);
    session.closing = true;
    session.socket?.close();
    await signalGroup(session.pid, session.processStart);
  }

  function getOutputTail(sessionHandle: string, maxBytes = OUTPUT_TAIL_BYTES): string | null {
    if (!isAppServerHandle(sessionHandle)) return null;
    const path = logPath(sessionHandle.slice(HANDLE_PREFIX.length));
    try {
      if (!existsSync(path)) return '';
      return stripAnsi(readFileSync(path).subarray(-maxBytes).toString('utf8')).trim();
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
          reason: 'app-server session is attached to another process (the coordinator adopts it on start); stop it with orc worker-remove',
        };
      }
      const exit = readAppServerExit(sessionHandle.slice(HANDLE_PREFIX.length));
      return {
        transport: 'app-server', alive: false, writable: false, pid: null, processStart: null,
        reason: exit ? `app-server process exited (${describeExit(exit)})` : 'app-server session is not attached to this process and its process is gone',
      };
    }
    const alive = session.connected;
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
    /**
     * Drop this process's connection and leave the app-server running, as a
     * coordinator exit does; the next coordinator adopts it (`adoptSession`).
     */
    detach(sessionHandle: string): void {
      const session = sessions.get(sessionHandle);
      if (!session) return;
      sessions.delete(sessionHandle);
      session.closing = true;
      session.socket?.close();
    },
    /** True while a turn is running or being started; new input would be refused. */
    turnActive(sessionHandle: string): boolean {
      const session = sessions.get(sessionHandle);
      return Boolean(session?.connected && (session.activeTurnId || session.submitting));
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
    adoptSession,
    /** The app-server runs detached; the next coordinator adopts it. */
    survivesCoordinatorExit(sessionHandle: string): boolean {
      return isAppServerHandle(sessionHandle);
    },
    /** Read from the exit file the wrapper writes, so any process sees it. */
    exitStatus(sessionHandle: string): SessionExitStatus | null {
      return isAppServerHandle(sessionHandle) ? readAppServerExit(sessionHandle.slice(HANDLE_PREFIX.length)) : null;
    },
    /** Test/diagnostic view of the provider thread behind a session. */
    threadId(sessionHandle: string): string | null {
      return sessions.get(sessionHandle)?.threadId ?? null;
    },
  };
}

export type CodexAppServerAdapter = ReturnType<typeof createCodexAppServerAdapter>;
