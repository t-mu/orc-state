import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE, ControlError, OPERATOR_TOKEN_FILE,
  OPERATOR_HEADER, PROTOCOL_HEADER, SESSION_HEADER,
  type AckState, type ControlEndpoint, type ControlResponse, type StreamFrame, type SubmitCommandRequest,
} from './controlProtocol.ts';
import type { DurableCommand } from './commandDelivery.ts';
import type { SemanticMessage, SendMessageInput } from './messageRouter.ts';
import type { ControlSnapshot } from './statusProjection.ts';
import type { TerminalRecord } from './terminalBroker.ts';
import type { LifecycleRequest, LifecycleResult } from './workerLifecycle.ts';
import type { OperatorRequest } from './operatorMutations.ts';
import type { ReviewSubmittedEvent } from '../types/events.ts';

export interface EventRow { seq: number; event: unknown }

export interface ControlClientOptions {
  /** Actor credential for mutations: the caller's running provider session ID. */
  sessionToken?: string | null;
  timeoutMs?: number;
}

/** Read the endpoint and token on every call so a restarted daemon is found again. */
function discover(stateDir: string): { endpoint: ControlEndpoint; token: string } {
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
  // A project worker is handed its coordinator's socket explicitly; the bearer token still comes from the state dir.
  const socket = process.env.ORC_CONTROL_SOCKET?.trim();
  return { endpoint: socket ? { ...endpoint, path: socket } : endpoint, token };
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
  private readonly sessionToken: string | null;
  private readonly timeoutMs: number;
  constructor(stateDir: string, options: ControlClientOptions = {}) {
    this.stateDir = stateDir;
    this.sessionToken = options.sessionToken ?? null;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** A client with a session presents its secret; one without acts as the operator if it can read the operator token. */
  private headers(token: string): Record<string, string> {
    const operatorToken = this.sessionToken ? '' : readOperatorToken(this.stateDir);
    return {
      authorization: `Bearer ${token}`,
      [PROTOCOL_HEADER]: String(CONTROL_PROTOCOL_VERSION),
      ...(this.sessionToken ? { [SESSION_HEADER]: this.sessionToken } : {}),
      ...(operatorToken ? { [OPERATOR_HEADER]: operatorToken } : {}),
    };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { endpoint, token } = discover(this.stateDir);
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

  snapshot(): Promise<ControlSnapshot> { return this.call('GET', '/v1/snapshot'); }

  messages(includeConsumed = false): Promise<{ messages: SemanticMessage[] }> {
    return this.call('GET', `/v1/messages${includeConsumed ? '?include_consumed=1' : ''}`);
  }

  sendMessage(input: SendMessageInput): Promise<{ message: SemanticMessage }> {
    return this.call('POST', '/v1/messages', {
      run_id: input.runId, recipient_session_id: input.recipientSessionId,
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

  /** `initialized` is false when the project has no memory store yet. */
  memoryWakeUp(opts: { wing?: string | null; budget?: number } = {}): Promise<{ initialized: boolean; text: string }> {
    const query = new URLSearchParams();
    if (opts.wing) query.set('wing', opts.wing);
    if (opts.budget !== undefined) query.set('budget', String(opts.budget));
    const suffix = query.size ? `?${query}` : '';
    return this.call('GET', `/v1/memory/wake-up${suffix}`);
  }

  /** Apply a master (its session) or operator (the operator token) mutation in the coordinator. */
  operator(request: OperatorRequest): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/operator', request);
  }

  listTasks(): Promise<{ tasks: Array<Record<string, unknown>> }> {
    return this.call('GET', '/v1/tasks');
  }

  getTask(ref: string): Promise<{ task: Record<string, unknown> }> {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(ref)}`);
  }

  createTask(input: Record<string, unknown>): Promise<{ task: Record<string, unknown> }> {
    return this.call('POST', '/v1/tasks', input);
  }

  /** Fails with `conflict` when `expectedRevision` is no longer the latest revision. */
  reviseTask(ref: string, expectedRevision: number, changes: Record<string, unknown>): Promise<{ task: Record<string, unknown>; changed: boolean }> {
    return this.call('POST', `/v1/tasks/${encodeURIComponent(ref)}/revisions`, { ...changes, expected_revision: expectedRevision });
  }

  openTerminal(kind: 'provider' | 'shell', runId: string): Promise<{ terminal: TerminalRecord }> {
    return this.call('POST', `/v1/terminals/${kind}`, { run_id: runId });
  }

  observeTerminal(terminalId: string, after = 0): Promise<{ terminal: TerminalRecord; screen: string; output: string; cursor: number }> {
    return this.call('GET', `/v1/terminals/${encodeURIComponent(terminalId)}?after=${after}`);
  }

  acquireTerminal(terminalId: string, ownerId: string): Promise<{ lease_id: string; expires_at: string }> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, { action: 'acquire', owner_id: ownerId });
  }

  renewTerminal(terminalId: string, leaseId: string): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, { action: 'renew', lease_id: leaseId });
  }

  releaseTerminal(terminalId: string, leaseId: string): Promise<void> {
    return this.call('POST', `/v1/terminals/${encodeURIComponent(terminalId)}/lease`, { action: 'release', lease_id: leaseId });
  }

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
    const { endpoint, token } = discover(this.stateDir);
    const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: endpoint.path, path: `/v1/events/stream?after=${after}`, method: 'GET', agent: false, headers: this.headers(token), signal }, resolve);
      req.on('error', (error) => reject(connectionError(error)));
      req.end();
    });
    if (res.statusCode !== 200) {
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(chunk as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ControlResponse<never>;
      throw parsed.ok ? new Error('Unexpected stream response') : new ControlError(parsed.error.code, parsed.error.message, res.statusCode ?? 500);
    }
    const lines = createInterface({ input: res, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line) as StreamFrame;
        if (frame.type === 'event') yield { seq: frame.seq, event: frame.event };
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && !signal?.aborted) throw error;
    } finally {
      lines.close();
      res.destroy();
    }
  }
}
