import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE, ControlError, OPERATOR_TOKEN_FILE,
  OPERATOR_HEADER, PROTOCOL_HEADER, SESSION_HEADER,
  type AckState, type ControlEndpoint, type ControlResponse, type SessionTerminalView, type StreamFrame, type SubmitCommandRequest,
  type TerminalFrame,
} from './controlProtocol.ts';
import type { ControlHealth } from './controlServer.ts';
import type { DurableCommand } from './commandDelivery.ts';
import type { SemanticMessage, SendMessageInput } from './messageRouter.ts';
import type { ControlSnapshot } from './statusProjection.ts';
import type { StatusView } from './statusView.ts';
import type { TerminalRecord } from './terminalBroker.ts';
import type { LifecycleRequest, LifecycleResult } from './workerLifecycle.ts';
import type { OperatorOp, OperatorRequest, OperatorResult } from './operatorMutations.ts';
import type { ProjectTaskView, TaskAuthoringInput } from './projectTasks.ts';
import type { PlanImportResult, TaskImportResult, TaskMarkdownSource } from './taskMarkdown.ts';
import type { ScoutReportView } from './scouts.ts';
import type { ReviewSubmittedEvent } from '../types/events.ts';

export interface EventRow { seq: number; event: unknown }
export type { OperatorResult, OperatorResults } from './operatorMutations.ts';


export interface ControlClientOptions {
  /** The session secret the caller presents (ORC_SESSION_SECRET or ORC_MASTER_SECRET). */
  credential?: string | null;
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
  if (endpoint.protocol_version !== CONTROL_PROTOCOL_VERSION || endpoint.transport !== 'unix') {
    throw new ControlError('unsupported_protocol_version',
      `Daemon endpoint uses protocol ${endpoint.protocol_version}/${endpoint.transport}; client supports ${CONTROL_PROTOCOL_VERSION}/unix`, 400);
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

export class ControlClient {
  private readonly stateDir: string;
  private readonly credential: string | null;
  private readonly timeoutMs: number;
  private readonly streamIdleMs: number;
  private readonly socketPath: string | null;
  constructor(stateDir: string, options: ControlClientOptions = {}) {
    this.stateDir = stateDir;
    this.credential = options.credential ?? null;
    this.timeoutMs = options.timeoutMs ?? 10_000;
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

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { endpoint, token } = discover(this.stateDir, this.socketPath);
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request({
        // No pooled sockets: a pooled connection can outlive a daemon restart.
        socketPath: endpoint.path, path, method, timeout: this.timeoutMs, agent: false,
        headers: { ...this.headers(token), ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ControlResponse<T>;
            if (parsed.ok) resolve(parsed.result);
            else reject(new ControlError(parsed.error.code, parsed.error.message, res.statusCode ?? 500));
          } catch (error) {
            reject(error as Error);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Control request timed out')));
      req.on('error', (error) => reject(connectionError(error)));
      req.end(text);
    });
  }

  /** What the running coordinator has loaded (`GET /v1/health`); any authenticated caller may ask. */
  health(): Promise<ControlHealth> { return this.call('GET', '/v1/health'); }

  snapshot(): Promise<ControlSnapshot> { return this.call('GET', '/v1/snapshot'); }

  /** The `orc status --json` view; `events` (0-200, default 20) sets how many recent events it carries. */
  status({ events }: { events?: number } = {}): Promise<StatusView> {
    return this.call('GET', `/v1/status${events === undefined ? '' : `?events=${events}`}`);
  }

  messages(includeConsumed = false): Promise<{ messages: SemanticMessage[] }> {
    return this.call('GET', `/v1/messages${includeConsumed ? '?include_consumed=1' : ''}`);
  }

  sendMessage(input: SendMessageInput): Promise<{ message: SemanticMessage }> {
    return this.call('POST', '/v1/messages', {
      run_id: input.runId, recipient_session_id: input.recipientSessionId, recipient_agent_id: input.recipientAgentId,
      idempotency_key: input.idempotencyKey, kind: input.kind, text: input.text,
      artifact_refs: input.artifactRefs, parent_message_id: input.parentMessageId,
    });
  }

  consumeMessage(messageId: string): Promise<{ message: SemanticMessage }> {
    return this.call('POST', `/v1/messages/${encodeURIComponent(messageId)}/consume`);
  }

  events(after: number, limit = 100): Promise<{ events: EventRow[]; cursor: number }> {
    return this.call('GET', `/v1/events?after=${after}&limit=${limit}`);
  }

  submitCommand(input: SubmitCommandRequest): Promise<{ command: DurableCommand }> {
    return this.call('POST', '/v1/commands', input);
  }

  acknowledge(commandId: string, state: AckState): Promise<{ command: DurableCommand }> {
    return this.call('POST', `/v1/commands/${encodeURIComponent(commandId)}/ack`, { state });
  }

  /** Apply a worker lifecycle request in the coordinator, scoped to this client's session. */
  lifecycle(request: LifecycleRequest): Promise<LifecycleResult> {
    return this.call('POST', '/v1/lifecycle', request);
  }

  reviews(runId: string): Promise<{ reviews: ReviewSubmittedEvent[] }> {
    return this.call('GET', `/v1/runs/${encodeURIComponent(runId)}/reviews`);
  }

  /** A worker's Stop hook: may this session end its turn? The coordinator resolves the session's run. */
  stopCheck(stopHookActive: boolean): Promise<{ allow: boolean; reason?: string }> {
    return this.call('POST', '/v1/stop-check', { stop_hook_active: stopHookActive });
  }

  /** `initialized` is false when the project has no memory store yet. */
  memoryWakeUp(opts: { wing?: string | null; budget?: number } = {}): Promise<{ initialized: boolean; text: string }> {
    const query = new URLSearchParams();
    if (opts.wing) query.set('wing', opts.wing);
    if (opts.budget !== undefined) query.set('budget', String(opts.budget));
    const suffix = query.size ? `?${query}` : '';
    return this.call('GET', `/v1/memory/wake-up${suffix}`);
  }

  /** Apply a master (its session) or operator (the operator token) mutation in the coordinator. */
  operator<Op extends OperatorOp>(request: OperatorRequest & { op: Op }): Promise<OperatorResult<Op>> {
    return this.call('POST', '/v1/operator', request);
  }

  listTasks(): Promise<{ tasks: ProjectTaskView[] }> {
    return this.call('GET', '/v1/tasks');
  }

  getTask(ref: string): Promise<{ task: ProjectTaskView }> {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(ref)}`);
  }

  createTask(input: TaskAuthoringInput, actorId?: string): Promise<{ task: ProjectTaskView }> {
    return this.call('POST', '/v1/tasks', { ...input, ...(actorId === undefined ? {} : { actor_id: actorId }) });
  }

  /** Fails with `conflict` when `expectedRevision` is no longer the latest revision. */
  reviseTask(ref: string, expectedRevision: number, changes: TaskAuthoringInput, actorId?: string): Promise<{ task: ProjectTaskView; changed: boolean }> {
    return this.call('POST', `/v1/tasks/${encodeURIComponent(ref)}/revisions`, { ...changes, expected_revision: expectedRevision,
      ...(actorId === undefined ? {} : { actor_id: actorId }) });
  }

  /** Sends specs the caller read itself (readTaskMarkdownSources); the coordinator never opens a caller's path. */
  importTasks(files: TaskMarkdownSource[], strict = false, actorId?: string): Promise<{ imported: TaskImportResult[] }> {
    return this.call('POST', '/v1/tasks/import', { files, strict, ...(actorId === undefined ? {} : { actor_id: actorId }) });
  }

  /** Sends plans the caller read itself (readPlanMarkdownSource); all are stored or none. */
  importPlans(files: TaskMarkdownSource[], actorId?: string): Promise<{ imported: PlanImportResult[] }> {
    return this.call('POST', '/v1/plans/import', { files, ...(actorId === undefined ? {} : { actor_id: actorId }) });
  }

  /** A scout's report (`GET /v1/scouts/<agent_id>/report`); master or operator only. */
  scoutReport(agentId: string): Promise<ScoutReportView> {
    return this.call('GET', `/v1/scouts/${encodeURIComponent(agentId)}/report`);
  }

  openTerminal(kind: 'provider' | 'shell', runId: string): Promise<{ terminal: TerminalRecord }> {
    return this.call('POST', `/v1/terminals/${kind}`, { run_id: runId });
  }

  /** Running sessions; `terminal_id` is null for one with no terminal to stream (`app:` sessions). */
  sessions(): Promise<{ sessions: SessionTerminalView[] }> { return this.call('GET', '/v1/sessions'); }

  /**
   * Yield a terminal's frames: one `snapshot`, then `output`/`resize`/`heartbeat`, and
   * `exit` last (reason `backlog`: the viewer fell too far behind). A stream silent
   * for `streamIdleMs` fails with `unavailable`. Pass the size to have the pane sized (by the lease holder, or
   * the first viewer when no one holds the lease). No reconnect: reopen after `exit`.
   */
  async *streamTerminal(terminalId: string, options: { leaseId?: string; columns?: number; rows?: number } = {}, signal?: AbortSignal): AsyncGenerator<TerminalFrame> {
    const query = new URLSearchParams();
    if (options.leaseId) query.set('lease_id', options.leaseId);
    if (options.columns !== undefined) query.set('columns', String(options.columns));
    if (options.rows !== undefined) query.set('rows', String(options.rows));
    const suffix = query.size ? `?${query}` : '';
    yield* this.ndjson<TerminalFrame>(`/v1/terminals/${encodeURIComponent(terminalId)}/stream${suffix}`, signal);
  }

  /**
   * The exclusive input lease. `ttlMs` (1000–120000, default 30000) is its term
   * from now and from each renew or input; `takeover` (operator only) replaces a live holder's lease.
   */
  acquireTerminal(terminalId: string, ownerId: string, options: { ttlMs?: number; takeover?: boolean } = {}): Promise<{ lease_id: string; expires_at: string }> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, {
      action: options.takeover ? 'takeover' : 'acquire', owner_id: ownerId, ...(options.ttlMs === undefined ? {} : { ttl_ms: options.ttlMs }),
    });
  }

  renewTerminal(terminalId: string, leaseId: string): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, { action: 'renew', lease_id: leaseId });
  }

  releaseTerminal(terminalId: string, leaseId: string): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, { action: 'release', lease_id: leaseId });
  }

  /** Resolves once the terminal has the input. Send one request at a time: concurrent ones may arrive out of order. */
  inputTerminal(terminalId: string, leaseId: string, data: string): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/input`, { lease_id: leaseId, data });
  }

  resizeTerminal(terminalId: string, leaseId: string, columns: number, rows: number): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/resize`, { lease_id: leaseId, columns, rows });
  }

  /**
   * Yield events with seq > after until the signal aborts or the stream ends.
   * Callers reconnect with the last seq they processed to resume without gaps.
   */
  async *subscribe(after: number, signal?: AbortSignal): AsyncGenerator<EventRow> {
    for await (const frame of this.ndjson<StreamFrame>(`/v1/events/stream?after=${after}`, signal)) {
      if (frame.type === 'event') yield { seq: frame.seq, event: frame.event };
      else if (frame.type === 'closed') return;
    }
  }

  private async *ndjson<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
    const { endpoint, token } = discover(this.stateDir, this.socketPath);
    const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: endpoint.path, path, method: 'GET', agent: false, headers: this.headers(token), signal }, resolve);
      req.on('error', (error) => reject(connectionError(error)));
      req.end();
    });
    if (res.statusCode !== 200) {
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(chunk as Buffer);
      const status = res.statusCode ?? 500;
      let parsed: ControlResponse<never>;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ControlResponse<never>; }
      catch { throw new ControlError(status >= 500 ? 'unavailable' : 'internal', `Stream open failed with HTTP ${status} and a non-JSON body`, status); }
      throw parsed.ok ? new Error('Unexpected stream response') : new ControlError(parsed.error.code, parsed.error.message, status);
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
