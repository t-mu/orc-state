import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_PROTOCOL_VERSIONS, CONTROL_TOKEN_FILE, ControlError, OPERATOR_TOKEN_FILE,
  OPERATOR_HEADER, PROTOCOL_HEADER, SESSION_HEADER,
  type AckState, type ControlEndpoint, type ControlErrorCode, type ControlResponse, type SessionTerminalView, type StreamFrame, type SubmitCommandRequest,
  type TerminalFrame,
} from './controlProtocol.ts';
import type { ControlHealth } from './controlServer.ts';
import type { DurableCommand } from './commandDelivery.ts';
import type { SemanticMessage, SendMessageInput } from './messageRouter.ts';
import type { ControlSnapshot } from './statusProjection.ts';
import type { RunListRow, RunListState } from './runList.ts';
import type { StatusView } from './statusView.ts';
import type { TerminalRecord } from './terminalBroker.ts';
import type { LifecycleRequest, LifecycleResult } from './workerLifecycle.ts';
import type { OperatorOp, OperatorRequest, OperatorResult } from './operatorMutations.ts';
import type { ProjectTaskSummary, ProjectTaskView, TaskAuthoringInput } from './projectTasks.ts';
import type { TaskRevisionSummary } from './projectTaskStore.ts';
import type { Claim } from '../types/claims.ts';
import type { PlanImportResult, TaskImportResult, TaskMarkdownSource } from './taskMarkdown.ts';
import type { ScoutReportView } from './scouts.ts';
import type { OrcEvent, ReviewSubmittedEvent } from '../types/events.ts';

/** `GET /v1/runs/<run_id>`: the claim with its task title, worktree and live session (null when none runs). */
export type RunDetail = Claim & { task_title: string | null; worktree_path: string | null; session: SessionTerminalView | null };

/** `event` is null for a corrupt row; its `seq` still advances the cursor. */
export interface EventRow { seq: number; event: OrcEvent | null }

/** Narrow `GET /v1/events` to one run, agent or event type. */
export interface EventFilter { runId?: string; agentId?: string; eventType?: string }
export type { OperatorResult, OperatorResults } from './operatorMutations.ts';


/**
 * Per-call options, the last argument of every client method. `signal` aborts the
 * call: the request is destroyed and the promise rejects with `ControlError('aborted')`
 * (a stream instead ends without an error). `timeoutMs` bounds the whole request and
 * rejects with `ControlError('timeout')`; 0 disables it. Defaults: the client's
 * `timeoutMs` (10 s), `importTasks`/`importPlans` at least `LONG_REQUEST_TIMEOUT_MS`
 * (5 min); a stream has no overall timeout (its `timeoutMs` bounds only opening it,
 * default `streamIdleMs`), the idle watchdog guards it once open.
 */
export interface CallOptions { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Default floor for calls that carry large bodies (task and plan import, up to 32 MiB). */
export const LONG_REQUEST_TIMEOUT_MS = 300_000;

export interface ControlClientOptions {
  /** The session secret the caller presents (ORC_SESSION_SECRET or ORC_MASTER_SECRET). */
  credential?: string | null;
  /** Default per-request timeout (10 s); a call's own `timeoutMs` overrides it. */
  timeoutMs?: number;
  /** An event or terminal stream that sends nothing for this long (3 daemon heartbeats by default) fails with `unavailable`. */
  streamIdleMs?: number;
  /**
   * Connect to this socket instead of the one in the endpoint descriptor (the
   * bearer token still comes from the state directory). Without it the
   * descriptor's socket is used; the process environment is never consulted.
   */
  socketPath?: string | null;
}

/**
 * The socket a project worker is handed in `ORC_CONTROL_SOCKET`, for the CLI
 * to pass as `socketPath`; null when unset or blank.
 */
export function controlSocketFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ORC_CONTROL_SOCKET?.trim() || null;
}

/** Read the endpoint and token on every call so a restarted daemon is found again. */
function discover(stateDir: string, socketPath: string | null): { endpoint: ControlEndpoint; token: string } {
  let endpoint: ControlEndpoint;
  let token: string;
  try {
    endpoint = JSON.parse(readFileSync(join(stateDir, CONTROL_ENDPOINT_FILE), 'utf8')) as ControlEndpoint;
    token = readFileSync(join(stateDir, CONTROL_TOKEN_FILE), 'utf8').trim();
  } catch {
    throw new ControlError('unavailable', 'Control daemon is not running (no endpoint descriptor)', 503);
  }
  // The protocol version is negotiated per request (see protocolMismatch); only the transport must match here.
  if (endpoint.transport !== 'unix') {
    throw new ControlError('unsupported_protocol_version',
      `Daemon endpoint uses transport ${String(endpoint.transport)}; client supports unix`, 400);
  }
  return { endpoint: socketPath ? { ...endpoint, path: socketPath } : endpoint, token };
}

/** The operator token the running coordinator wrote; empty when it cannot be read (the server then refuses). */
function readOperatorToken(stateDir: string): string {
  try {
    return readFileSync(join(stateDir, OPERATOR_TOKEN_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

/** A crashed daemon leaves its descriptor behind; report it like a stopped one. */
function connectionError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED' || code === 'ENOENT') {
    return new ControlError('unavailable', 'Control daemon is not running (stale endpoint descriptor)', 503);
  }
  // A sandbox that does not allow the control socket refuses the connect itself.
  if (code === 'EACCES' || code === 'EPERM') {
    return new ControlError('forbidden',
      `Connecting to the control socket was refused (${code}); a sandboxed project worker or Claude scout needs worker_pool.sandbox_network=open (see docs/configuration.md → Execution Modes)`, 403);
  }
  return error as Error;
}

/** A response body that is not a control envelope (a proxy page, a truncated reply, nothing at all). */
function bodyError(status: number, text: string, what: string, code: ControlErrorCode): ControlError {
  const excerpt = text.replace(/\s+/g, ' ').trim();
  const shown = excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt;
  return new ControlError(code,
    `${what} failed with HTTP ${status} and ${shown ? `a non-JSON body: ${shown}` : 'an empty body'}`, status);
}

/**
 * `badBodyCode` is what a non-envelope body becomes: `internal` for a request (it reached
 * a server, so callers must not treat it as never sent), `unavailable` for a 5xx stream open.
 */
function parseEnvelope<T>(status: number, text: string, what: string, badBodyCode: ControlErrorCode = 'internal'): ControlResponse<T> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw bodyError(status, text, what, badBodyCode); }
  const envelope = parsed as ControlResponse<T> | null;
  if (typeof envelope !== 'object' || envelope === null || typeof envelope.ok !== 'boolean'
    || (!envelope.ok && (typeof envelope.error !== 'object' || envelope.error === null))) {
    throw bodyError(status, text, what, badBodyCode);
  }
  return envelope;
}

type Discovered = { endpoint: ControlEndpoint; token: string };

/** Longest the health lookup after a version refusal may take. */
const NEGOTIATION_TIMEOUT_MS = 3_000;

/** What is left of a call's timeout for the follow-up health lookup, capped (and finite even when the call has none). */
function remainingBudget(timeoutMs: number, started: number): number {
  if (timeoutMs <= 0) return NEGOTIATION_TIMEOUT_MS;
  return Math.max(1, Math.min(NEGOTIATION_TIMEOUT_MS, timeoutMs - (Date.now() - started)));
}

function abortedError(what: string): ControlError {
  return new ControlError('aborted', `${what} was aborted`, 499);
}

function timeoutError(what: string, timeoutMs: number): ControlError {
  return new ControlError('timeout', `${what} timed out after ${timeoutMs} ms`, 504);
}

function formatRange(range: readonly [number, number]): string {
  return `[${range[0]}, ${range[1]}]`;
}

/** Reject as soon as the signal fires, without waiting for `promise` (which still settles on its own). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortedError(what));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError(what));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function streamOptions(call: AbortSignal | CallOptions | undefined): CallOptions {
  if (call === undefined) return {};
  return call instanceof AbortSignal ? { signal: call } : call;
}

export class ControlClient {
  private readonly stateDir: string;
  private readonly credential: string | null;
  private readonly timeoutMs: number;
  private readonly streamIdleMs: number;
  private readonly socketPath: string | null;
  /** Tail of each terminal's input queue: inputs to one terminal are sent one at a time, in call order. */
  private readonly inputQueues = new Map<string, Promise<unknown>>();
  /**
   * `stateDir` names the project explicitly (`state_dir` from listProjects): it
   * must be an absolute path, so the client never falls back to the process's
   * cwd or environment to pick a project.
   */
  constructor(stateDir: string, options: ControlClientOptions = {}) {
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) {
      throw new TypeError(`ControlClient needs the project's absolute state directory (state_dir from listProjects), got ${JSON.stringify(stateDir)}`);
    }
    this.stateDir = stateDir;
    this.credential = options.credential ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.streamIdleMs = options.streamIdleMs ?? 30_000;
    this.socketPath = options.socketPath?.trim() || null;
  }

  /** A client with a session presents its secret; one without acts as the operator if it can read the operator token. */
  private headers(token: string): Record<string, string> {
    const operatorToken = this.credential ? '' : readOperatorToken(this.stateDir);
    return {
      authorization: `Bearer ${token}`,
      [PROTOCOL_HEADER]: String(CONTROL_PROTOCOL_VERSION),
      ...(this.credential ? { [SESSION_HEADER]: this.credential } : {}),
      ...(operatorToken ? { [OPERATOR_HEADER]: operatorToken } : {}),
    };
  }

  /** `defaultTimeoutMs` applies when the call passes no `timeoutMs`. */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, options: CallOptions = {}, defaultTimeoutMs = this.timeoutMs): Promise<T> {
    if (options.signal?.aborted) throw abortedError(`Control request ${method} ${path.split('?')[0]}`);
    // Discovery errors (no daemon, wrong transport) are local: they never start a version negotiation.
    const target = discover(this.stateDir, this.socketPath);
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const started = Date.now();
    try {
      return await this.request<T>(target, method, path, body, options, timeoutMs);
    } catch (error) {
      if (error instanceof ControlError && error.code === 'unsupported_protocol_version') {
        throw await this.protocolMismatch(error, target, options.signal, remainingBudget(timeoutMs, started));
      }
      throw error;
    }
  }

  private request<T>(target: Discovered, method: 'GET' | 'POST', path: string, body: unknown, options: CallOptions, timeoutMs: number): Promise<T> {
    const what = `Control request ${method} ${path.split('?')[0]}`;
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortedError(what));
    const { endpoint, token } = target;
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const fail = (error: Error): void => {
        if (!settle()) return;
        req.destroy();
        reject(error);
      };
      const onAbort = (): void => fail(abortedError(what));
      const req = request({
        // No pooled sockets: a pooled connection can outlive a daemon restart.
        socketPath: endpoint.path, path, method, agent: false,
        headers: { ...this.headers(token), ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) => fail(connectionError(error)));
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          let parsed: ControlResponse<T>;
          try { parsed = parseEnvelope<T>(status, Buffer.concat(chunks).toString('utf8'), what); }
          catch (error) { fail(error as Error); return; }
          if (!settle()) return;
          if (parsed.ok) resolve(parsed.result);
          else reject(new ControlError(parsed.error.code, parsed.error.message, status));
        });
      });
      if (timeoutMs > 0) timer = setTimeout(() => fail(timeoutError(what, timeoutMs)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (error) => fail(connectionError(error)));
      req.end(text);
    });
  }

  /**
   * The coordinator refused our protocol version: ask `/v1/health` (which needs no
   * protocol header) for its range and name both sides' ranges in the error.
   */
  private async protocolMismatch(original: ControlError, target: Discovered, signal: AbortSignal | undefined, timeoutMs: number): Promise<ControlError> {
    let theirs: string;
    try {
      const health = await this.request<Partial<ControlHealth>>(target, 'GET', '/v1/health', undefined, { signal }, timeoutMs);
      const range = health.protocol_versions
        ?? (typeof health.protocol_version === 'number' ? [health.protocol_version, health.protocol_version] as const : null);
      theirs = range ? formatRange(range) : 'an unknown range (its /v1/health does not report one)';
    } catch (error) {
      if (error instanceof ControlError && error.code === 'aborted') return error;
      theirs = `an unknown range (/v1/health failed: ${(error as Error).message})`;
    }
    return new ControlError('unsupported_protocol_version',
      `Control protocol mismatch: the coordinator supports versions ${theirs}; this client supports ${formatRange(CONTROL_PROTOCOL_VERSIONS)}. Update orc on the older side (${original.message})`,
      original.status);
  }

  /** What the running coordinator has loaded (`GET /v1/health`); any authenticated caller may ask. */
  health(options: CallOptions = {}): Promise<ControlHealth> { return this.call('GET', '/v1/health', undefined, options); }

  snapshot(options: CallOptions = {}): Promise<ControlSnapshot> { return this.call('GET', '/v1/snapshot', undefined, options); }

  /** The `orc runs --json` / MCP `list_runs` view (lib/runList.ts). */
  runs({ state, stale_after_ms }: { state?: RunListState | undefined; stale_after_ms?: number | undefined } = {}, options: CallOptions = {}): Promise<{ runs: RunListRow[] }> {
    const query = new URLSearchParams();
    if (state !== undefined) query.set('state', state);
    if (stale_after_ms !== undefined) query.set('stale_after_ms', String(stale_after_ms));
    const qs = query.toString();
    return this.call('GET', `/v1/runs${qs ? `?${qs}` : ''}`, undefined, options);
  }

  /** The `orc status --json` view; `events` (0-200, default 20) sets how many recent events it carries. */
  status({ events }: { events?: number } = {}, options: CallOptions = {}): Promise<StatusView> {
    return this.call('GET', `/v1/status${events === undefined ? '' : `?events=${events}`}`, undefined, options);
  }

  messages(includeConsumed = false, options: CallOptions = {}): Promise<{ messages: SemanticMessage[] }> {
    return this.call('GET', `/v1/messages${includeConsumed ? '?include_consumed=1' : ''}`, undefined, options);
  }

  sendMessage(input: SendMessageInput, options: CallOptions = {}): Promise<{ message: SemanticMessage }> {
    return this.call('POST', '/v1/messages', {
      run_id: input.runId, recipient_session_id: input.recipientSessionId, recipient_agent_id: input.recipientAgentId,
      idempotency_key: input.idempotencyKey, kind: input.kind, text: input.text,
      artifact_refs: input.artifactRefs, parent_message_id: input.parentMessageId,
    }, options);
  }

  consumeMessage(messageId: string, options: CallOptions = {}): Promise<{ message: SemanticMessage }> {
    return this.call('POST', `/v1/messages/${encodeURIComponent(messageId)}/consume`, undefined, options);
  }

  events(after: number, limit = 100, filter: EventFilter = {}, options: CallOptions = {}): Promise<{ events: EventRow[]; cursor: number }> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    if (filter.runId !== undefined) query.set('run_id', filter.runId);
    if (filter.agentId !== undefined) query.set('agent_id', filter.agentId);
    if (filter.eventType !== undefined) query.set('event_type', filter.eventType);
    return this.call('GET', `/v1/events?${query}`, undefined, options);
  }

  /** One run: its claim plus task title, worktree path and live session (`GET /v1/runs/<run_id>`); unknown id → `not_found`. */
  run(runId: string, options: CallOptions = {}): Promise<{ run: RunDetail }> {
    return this.call('GET', `/v1/runs/${encodeURIComponent(runId)}`, undefined, options);
  }

  submitCommand(input: SubmitCommandRequest, options: CallOptions = {}): Promise<{ command: DurableCommand }> {
    return this.call('POST', '/v1/commands', input, options);
  }

  acknowledge(commandId: string, state: AckState, options: CallOptions = {}): Promise<{ command: DurableCommand }> {
    return this.call('POST', `/v1/commands/${encodeURIComponent(commandId)}/ack`, { state }, options);
  }

  /** Apply a worker lifecycle request in the coordinator, scoped to this client's session. */
  lifecycle(request: LifecycleRequest, options: CallOptions = {}): Promise<LifecycleResult> {
    return this.call('POST', '/v1/lifecycle', request, options);
  }

  reviews(runId: string, options: CallOptions = {}): Promise<{ reviews: ReviewSubmittedEvent[] }> {
    return this.call('GET', `/v1/runs/${encodeURIComponent(runId)}/reviews`, undefined, options);
  }

  /** A worker's Stop hook: may this session end its turn? The coordinator resolves the session's run. */
  stopCheck(stopHookActive: boolean, options: CallOptions = {}): Promise<{ allow: boolean; reason?: string }> {
    return this.call('POST', '/v1/stop-check', { stop_hook_active: stopHookActive }, options);
  }

  /** `initialized` is false when the project has no memory store yet. */
  memoryWakeUp(opts: { wing?: string | null; budget?: number } = {}, options: CallOptions = {}): Promise<{ initialized: boolean; text: string }> {
    const query = new URLSearchParams();
    if (opts.wing) query.set('wing', opts.wing);
    if (opts.budget !== undefined) query.set('budget', String(opts.budget));
    const suffix = query.size ? `?${query}` : '';
    return this.call('GET', `/v1/memory/wake-up${suffix}`, undefined, options);
  }

  /** Apply a master (its session) or operator (the operator token) mutation in the coordinator. */
  operator<Op extends OperatorOp>(request: OperatorRequest & { op: Op }, options: CallOptions = {}): Promise<OperatorResult<Op>> {
    return this.call('POST', '/v1/operator', request, options);
  }

  /** `fields: 'summary'` omits `body_markdown`; `status` keeps one task status. */
  listTasks(opts: { status?: string; fields: 'summary' }, options?: CallOptions): Promise<{ tasks: ProjectTaskSummary[] }>;
  listTasks(opts?: { status?: string }, options?: CallOptions): Promise<{ tasks: ProjectTaskView[] }>;
  listTasks(opts: { status?: string; fields?: 'summary' } = {}, options: CallOptions = {}): Promise<{ tasks: ProjectTaskView[] | ProjectTaskSummary[] }> {
    const query = new URLSearchParams();
    if (opts.status !== undefined) query.set('status', opts.status);
    if (opts.fields !== undefined) query.set('fields', opts.fields);
    return this.call('GET', `/v1/tasks${query.size ? `?${query}` : ''}`, undefined, options);
  }

  getTask(ref: string, options: CallOptions = {}): Promise<{ task: ProjectTaskView }> {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(ref)}`, undefined, options);
  }

  /** Every revision of a task, oldest first, without the bodies (`GET /v1/tasks/<ref>/revisions`). */
  taskRevisions(ref: string, options: CallOptions = {}): Promise<{ revisions: TaskRevisionSummary[] }> {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(ref)}/revisions`, undefined, options);
  }

  createTask(input: TaskAuthoringInput, actorId?: string, options: CallOptions = {}): Promise<{ task: ProjectTaskView }> {
    return this.call('POST', '/v1/tasks', { ...input, ...(actorId === undefined ? {} : { actor_id: actorId }) }, options);
  }

  /** Fails with `conflict` when `expectedRevision` is no longer the latest revision. */
  reviseTask(ref: string, expectedRevision: number, changes: TaskAuthoringInput, actorId?: string, options: CallOptions = {}): Promise<{ task: ProjectTaskView; changed: boolean }> {
    return this.call('POST', `/v1/tasks/${encodeURIComponent(ref)}/revisions`, { ...changes, expected_revision: expectedRevision,
      ...(actorId === undefined ? {} : { actor_id: actorId }) }, options);
  }

  /** Sends specs the caller read itself (readTaskMarkdownSources); the coordinator never opens a caller's path. */
  importTasks(files: TaskMarkdownSource[], strict = false, actorId?: string, options: CallOptions = {}): Promise<{ imported: TaskImportResult[] }> {
    return this.call('POST', '/v1/tasks/import', { files, strict, ...(actorId === undefined ? {} : { actor_id: actorId }) },
      options, Math.max(this.timeoutMs, LONG_REQUEST_TIMEOUT_MS));
  }

  /** Sends plans the caller read itself (readPlanMarkdownSource); all are stored or none. */
  importPlans(files: TaskMarkdownSource[], actorId?: string, options: CallOptions = {}): Promise<{ imported: PlanImportResult[] }> {
    return this.call('POST', '/v1/plans/import', { files, ...(actorId === undefined ? {} : { actor_id: actorId }) },
      options, Math.max(this.timeoutMs, LONG_REQUEST_TIMEOUT_MS));
  }

  /** A scout's report (`GET /v1/scouts/<agent_id>/report`); master or operator only. */
  scoutReport(agentId: string, options: CallOptions = {}): Promise<ScoutReportView> {
    return this.call('GET', `/v1/scouts/${encodeURIComponent(agentId)}/report`, undefined, options);
  }

  openTerminal(kind: 'provider' | 'shell', runId: string, options: CallOptions = {}): Promise<{ terminal: TerminalRecord }> {
    return this.call('POST', `/v1/terminals/${kind}`, { run_id: runId }, options);
  }

  /**
   * The provider terminal of an agent's running session, by agent id: a worker,
   * a scout or the master. Stream, lease and input it by its `terminal_id` as any other.
   */
  openAgentTerminal(agentId: string, options: CallOptions = {}): Promise<{ terminal: TerminalRecord }> {
    return this.call('POST', '/v1/terminals/provider', { agent_id: agentId }, options);
  }

  /** Running sessions; `terminal_id` is null for one with no terminal to stream (`app:` sessions). */
  sessions(options: CallOptions = {}): Promise<{ sessions: SessionTerminalView[] }> { return this.call('GET', '/v1/sessions', undefined, options); }

  /**
   * Yield a terminal's frames: one `snapshot`, then `output`/`resize`/`heartbeat`, and
   * `exit` last (reason `backlog`: the viewer fell too far behind). A stream silent
   * for `streamIdleMs` fails with `unavailable`. Pass the size to have the pane sized (by the lease holder, or
   * the first viewer when no one holds the lease). No reconnect: reopen after `exit`.
   * Aborting `call` (a signal or `CallOptions`) ends the stream without an error.
   */
  async *streamTerminal(terminalId: string, options: { leaseId?: string; columns?: number; rows?: number } = {}, call?: AbortSignal | CallOptions): AsyncGenerator<TerminalFrame> {
    const query = new URLSearchParams();
    if (options.leaseId) query.set('lease_id', options.leaseId);
    if (options.columns !== undefined) query.set('columns', String(options.columns));
    if (options.rows !== undefined) query.set('rows', String(options.rows));
    const suffix = query.size ? `?${query}` : '';
    yield* this.ndjson<TerminalFrame>(`/v1/terminals/${encodeURIComponent(terminalId)}/stream${suffix}`, streamOptions(call));
  }

  /**
   * The exclusive input lease. `ttlMs` (1000–120000, default 30000) is its term
   * from now and from each renew or input; `takeover` (operator only) replaces a live holder's lease.
   */
  acquireTerminal(terminalId: string, ownerId: string, lease: { ttlMs?: number; takeover?: boolean } = {}, options: CallOptions = {}): Promise<{ lease_id: string; expires_at: string }> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, {
      action: lease.takeover ? 'takeover' : 'acquire', owner_id: ownerId, ...(lease.ttlMs === undefined ? {} : { ttl_ms: lease.ttlMs }),
    }, options);
  }

  renewTerminal(terminalId: string, leaseId: string, options: CallOptions = {}): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, { action: 'renew', lease_id: leaseId }, options);
  }

  releaseTerminal(terminalId: string, leaseId: string, options: CallOptions = {}): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, { action: 'release', lease_id: leaseId }, options);
  }

  /**
   * Resolves once the terminal has the input. Calls on one client for one terminal are
   * queued and sent one at a time in call order, each after the previous one settles
   * (a failed input is not retried; later ones are still sent). A retry, e.g. after
   * `busy`, joins the back of the queue: to keep order, queue nothing else until it settles.
   * The timeout counts from the send; aborting a queued call rejects it at once, unsent.
   */
  inputTerminal(terminalId: string, leaseId: string, data: string, options: CallOptions = {}): Promise<void> {
    const previous = this.inputQueues.get(terminalId) ?? Promise.resolve();
    const sent = previous.then(() => this.call<void>('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/input`, { lease_id: leaseId, data }, options));
    const tail = sent.catch(() => undefined);
    this.inputQueues.set(terminalId, tail);
    void tail.then(() => { if (this.inputQueues.get(terminalId) === tail) this.inputQueues.delete(terminalId); });
    return raceAbort(sent, options.signal, `Control request POST /v1/terminals/${encodeURIComponent(terminalId)}/input`);
  }

  resizeTerminal(terminalId: string, leaseId: string, columns: number, rows: number, options: CallOptions = {}): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/resize`, { lease_id: leaseId, columns, rows }, options);
  }

  /**
   * Yield events with seq > after until the signal aborts or the stream ends.
   * Callers reconnect with the last seq they processed to resume without gaps.
   * Aborting `call` (a signal or `CallOptions`) ends the stream without an error.
   */
  async *subscribe(after: number, call?: AbortSignal | CallOptions): AsyncGenerator<EventRow> {
    for await (const frame of this.ndjson<StreamFrame>(`/v1/events/stream?after=${after}`, streamOptions(call))) {
      if (frame.type === 'event') yield { seq: frame.seq, event: frame.event };
      else if (frame.type === 'closed') return;
    }
  }

  /** Open a stream: resolves with the 200 response, rejects with the server's error, `aborted`, or `timeout` before the headers arrive. */
  private openStream(target: Discovered, path: string, options: CallOptions, timeoutMs: number): Promise<import('node:http').IncomingMessage> {
    const what = `Control stream ${path.split('?')[0]}`;
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortedError(what));
    const { endpoint, token } = target;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const fail = (error: Error): void => { if (settle()) { req.destroy(); reject(error); } };
      const onAbort = (): void => fail(abortedError(what));
      const req = request({ socketPath: endpoint.path, path, method: 'GET', agent: false, headers: this.headers(token), ...(signal ? { signal } : {}) }, (res) => {
        if (res.statusCode === 200) { if (settle()) resolve(res); else res.destroy(); return; }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) => fail(connectionError(error)));
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          let parsed: ControlResponse<never>;
          try { parsed = parseEnvelope<never>(status, Buffer.concat(chunks).toString('utf8'), 'Stream open', status >= 500 ? 'unavailable' : 'internal'); }
          catch (error) { fail(error as Error); return; }
          fail(parsed.ok ? new ControlError('internal', `Stream open answered HTTP ${status} without a stream`, status)
            : new ControlError(parsed.error.code, parsed.error.message, status));
        });
      });
      if (timeoutMs > 0) timer = setTimeout(() => fail(timeoutError(what, timeoutMs)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (error) => fail(signal?.aborted ? abortedError(what) : connectionError(error)));
      req.end();
    });
  }

  private async *ndjson<T>(path: string, options: CallOptions): AsyncGenerator<T> {
    const { signal } = options;
    let res: import('node:http').IncomingMessage;
    if (signal?.aborted) return;
    const target = discover(this.stateDir, this.socketPath);
    const timeoutMs = options.timeoutMs ?? this.streamIdleMs;
    const started = Date.now();
    try {
      res = await this.openStream(target, path, options, timeoutMs);
    } catch (error) {
      if (error instanceof ControlError && error.code === 'aborted') return;
      if (error instanceof ControlError && error.code === 'unsupported_protocol_version') {
        const mismatch = await this.protocolMismatch(error, target, signal, remainingBudget(timeoutMs, started));
        if (mismatch.code === 'aborted') return;
        throw mismatch;
      }
      throw error;
    }
    // The daemon heartbeats every few seconds; silence for longer means it is stalled or gone.
    let idle: NodeJS.Timeout | undefined;
    let stalled = false;
    const lines = createInterface({ input: res, crlfDelay: Infinity });
    const rearm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; lines.close(); res.destroy(); }, this.streamIdleMs);
    };
    rearm();
    // A destroyed response emits 'close', not 'end', which would leave the reader waiting.
    res.on('close', () => lines.close());
    try {
      for await (const line of lines) {
        rearm();
        if (!line) continue;
        yield JSON.parse(line) as T;
      }
      if (stalled) throw new ControlError('unavailable', `No frame from the control daemon for ${this.streamIdleMs} ms`, 503);
      // A stream that ends without a final frame was cut: shutdown writes `closed`/`exit` first.
      if (!signal?.aborted && !res.complete) throw new ControlError('unavailable', 'Control stream was cut off', 503);
    } catch (error) {
      if (signal?.aborted || (error as Error).name === 'AbortError') return;
      if (error instanceof ControlError) throw error;
      if (stalled) throw new ControlError('unavailable', `No frame from the control daemon for ${this.streamIdleMs} ms`, 503);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') throw new ControlError('unavailable', 'Control stream was reset', 503);
      throw error;
    } finally {
      clearTimeout(idle);
      lines.close();
      res.destroy();
    }
  }
}
