import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE, ControlError,
  PROTOCOL_HEADER, SESSION_HEADER,
  type AckState, type ControlEndpoint, type ControlResponse, type StreamFrame, type SubmitCommandRequest,
} from './controlProtocol.ts';
import type { DurableCommand } from './commandDelivery.ts';
import type { ControlSnapshot } from './statusProjection.ts';

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
    throw new ControlError('internal', 'Control daemon is not running (no endpoint descriptor)', 503);
  }
  if (endpoint.protocol_version !== CONTROL_PROTOCOL_VERSION || endpoint.transport !== 'unix') {
    throw new ControlError('unsupported_protocol_version',
      `Daemon endpoint uses protocol ${endpoint.protocol_version}/${endpoint.transport}; client supports ${CONTROL_PROTOCOL_VERSION}/unix`, 400);
  }
  return { endpoint, token };
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

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      [PROTOCOL_HEADER]: String(CONTROL_PROTOCOL_VERSION),
      ...(this.sessionToken ? { [SESSION_HEADER]: this.sessionToken } : {}),
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
      req.on('error', reject);
      req.end(text);
    });
  }

  snapshot(): Promise<ControlSnapshot> { return this.call('GET', '/v1/snapshot'); }

  events(after: number, limit = 100): Promise<{ events: EventRow[]; cursor: number }> {
    return this.call('GET', `/v1/events?after=${after}&limit=${limit}`);
  }

  submitCommand(input: SubmitCommandRequest): Promise<{ command: DurableCommand }> {
    return this.call('POST', '/v1/commands', input);
  }

  acknowledge(commandId: string, state: AckState): Promise<{ command: DurableCommand }> {
    return this.call('POST', `/v1/commands/${encodeURIComponent(commandId)}/ack`, { state });
  }

  /**
   * Yield events with seq > after until the signal aborts or the stream ends.
   * Callers reconnect with the last seq they processed to resume without gaps.
   */
  async *subscribe(after: number, signal?: AbortSignal): AsyncGenerator<EventRow> {
    const { endpoint, token } = discover(this.stateDir);
    const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: endpoint.path, path: `/v1/events/stream?after=${after}`, method: 'GET', agent: false, headers: this.headers(token), signal }, resolve);
      req.on('error', reject);
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
