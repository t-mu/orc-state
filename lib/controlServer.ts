import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { CommandDispatcher, type CommandAuthenticator } from './commandDelivery.ts';
import {
  CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE, ControlError,
  PROTOCOL_HEADER, SESSION_HEADER, defaultSocketPath,
  type AckState, type ControlEndpoint, type ControlErrorCode, type StreamFrame, type SubmitCommandRequest,
} from './controlProtocol.ts';
import { readEventBatch, withEventDb } from './eventLog.ts';
import { readControlSnapshot } from './statusProjection.ts';
import { TerminalBroker } from './terminalBroker.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const ACK_STATES = new Set<AckState>(['accepted', 'running', 'completed', 'failed']);

export interface ControlServerOptions {
  socketPath?: string;
  /** Pass the coordinator's dispatcher once a delivery transport exists. */
  commands?: CommandDispatcher;
  pollMs?: number;
  heartbeatMs?: number;
  terminals?: TerminalBroker;
}

export interface ControlServer {
  endpoint: ControlEndpoint;
  close(): Promise<void>;
}

/**
 * A running provider session ID is the caller's actor credential. This is a
 * same-user scope check, not a security boundary: session IDs are readable in
 * agents.json, and any same-user process can open events.db directly. Legacy
 * imported IDs are derived from public names, so they are never accepted.
 */
export function sessionAuthenticator(stateDir: string): CommandAuthenticator {
  return (credential) => {
    if (credential.startsWith('legacy-')) return null;
    return withEventDb(stateDir, (db) => {
      const row = db.prepare("SELECT session_id, agent_id FROM sessions WHERE session_id = ? AND state = 'running'")
        .get(credential) as { session_id: string; agent_id: string } | undefined;
      return row ? { agentId: row.agent_id, sessionId: row.session_id } : null;
    });
  };
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }

// Exact command-delivery failure messages; anything else is an internal error.
const DOMAIN_ERRORS: Array<[string | RegExp, ControlErrorCode, number]> = [
  ['Command caller is not authenticated', 'unauthenticated', 401],
  ['Authenticated session is not running', 'forbidden', 403],
  ['Authenticated actor does not match session', 'forbidden', 403],
  ['Authenticated recipient does not match session', 'forbidden', 403],
  ['Actor is not scoped to the run', 'forbidden', 403],
  ['Recipient is not scoped to the run', 'forbidden', 403],
  ['ACK from wrong recipient', 'forbidden', 403],
  ['Run not found', 'not_found', 404],
  ['Command not found', 'not_found', 404],
  ['Run is not active', 'conflict', 409],
  ['Idempotency key conflicts with existing command', 'conflict', 409],
  [/^Cannot acknowledge \w+ as \w+$/, 'conflict', 409],
  ['Command key and kind are required', 'bad_request', 400],
  ['maxAttempts must be positive', 'bad_request', 400],
  ['Invalid deadline', 'bad_request', 400],
  ['Payload must be JSON serializable', 'bad_request', 400],
];

function classify(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  for (const [match, code, status] of DOMAIN_ERRORS) {
    if (typeof match === 'string' ? message === match : match.test(message)) return new ControlError(code, message, status);
  }
  return new ControlError('internal', message, 500);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown): void {
  const failure = classify(error);
  send(res, failure.status, { protocol_version: CONTROL_PROTOCOL_VERSION, ok: false, error: { code: failure.code, message: failure.message } });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ControlError('bad_request', 'Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ControlError('bad_request', 'Request body must be a JSON object', 400);
  }
}

function seqParam(url: URL, name: string): number {
  const raw = url.searchParams.get(name) ?? '0';
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new ControlError('bad_request', `${name} must be a non-negative integer`, 400);
  return value;
}

/** Refuse to steal a live socket; remove one left behind by a crashed daemon. */
async function clearStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const live = await new Promise<boolean>((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  if (live) throw new Error(`Control socket already in use: ${path}`);
  unlinkSync(path);
}

export async function startControlServer(stateDir: string, options: ControlServerOptions = {}): Promise<ControlServer> {
  const socketPath = options.socketPath ?? defaultSocketPath(stateDir);
  const pollMs = options.pollMs ?? 200;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const commands = options.commands ?? new CommandDispatcher(stateDir, {
    send: () => Promise.reject(new Error('Command transport is not configured')),
  }, sessionAuthenticator(stateDir));
  const terminals = options.terminals ?? new TerminalBroker(stateDir);
  const token = randomBytes(32).toString('hex');
  const tokenDigest = digest(token);
  const streams = new Set<ServerResponse>();
  let closing = false;
  const assertOpen = (): void => {
    if (closing) throw new ControlError('unavailable', 'Control daemon is shutting down', 503);
  };

  function authenticated(req: IncomingMessage): void {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !timingSafeEqual(digest(presented), tokenDigest)) {
      throw new ControlError('unauthenticated', 'Missing or invalid control token', 401);
    }
  }

  function actorCredential(req: IncomingMessage): string {
    const credential = req.headers[SESSION_HEADER];
    if (typeof credential !== 'string' || !credential) throw new ControlError('unauthenticated', 'Session credential required for mutations', 401);
    return credential;
  }

  function stream(res: ServerResponse, after: number): void {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    streams.add(res);
    let cursor = after;
    let draining = false;
    let lastWrite = Date.now();
    const write = (frame: StreamFrame): boolean => { lastWrite = Date.now(); return res.write(`${JSON.stringify(frame)}\n`); };
    const pump = (): void => {
      if (draining || res.destroyed) return;
      try {
        for (;;) {
          const rows = readEventBatch(join(stateDir, 'events.db'), cursor, 500);
          for (const row of rows) {
            cursor = row.seq;
            if (!write({ type: 'event', seq: row.seq, event: row.event })) {
              draining = true;
              res.once('drain', () => { draining = false; pump(); });
              return;
            }
          }
          if (rows.length < 500) break;
        }
        if (Date.now() - lastWrite >= heartbeatMs) write({ type: 'heartbeat', cursor });
      } catch (error) {
        res.destroy(error as Error);
      }
    };
    const timer = setInterval(pump, pollMs);
    res.on('close', () => { clearInterval(timer); streams.delete(res); });
    write({ type: 'heartbeat', cursor });
    pump();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    assertOpen();
    const version = req.headers[PROTOCOL_HEADER];
    if (version !== String(CONTROL_PROTOCOL_VERSION)) {
      throw new ControlError('unsupported_protocol_version',
        `Unsupported protocol version ${String(version ?? '(missing)')}; supported: ${CONTROL_PROTOCOL_VERSION}`, 400);
    }
    authenticated(req);
    const url = new URL(req.url ?? '/', 'http://orc.local');
    const ok = (result: unknown, status = 200) => send(res, status, { protocol_version: CONTROL_PROTOCOL_VERSION, ok: true, result });
    if (req.method === 'GET' && url.pathname === '/v1/snapshot') return ok(readControlSnapshot(stateDir));
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const after = seqParam(url, 'after');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ControlError('bad_request', 'limit must be between 1 and 1000', 400);
      const rows = readEventBatch(join(stateDir, 'events.db'), after, limit);
      return ok({ events: rows, cursor: rows.at(-1)?.seq ?? after });
    }
    if (req.method === 'GET' && url.pathname === '/v1/events/stream') return stream(res, seqParam(url, 'after'));
    if (req.method === 'POST' && url.pathname === '/v1/terminals/provider') {
      const body = await readBody(req);
      if (typeof body.run_id !== 'string' || !body.run_id) throw new ControlError('bad_request', 'run_id is required', 400);
      return ok({ terminal: terminals.provider(body.run_id) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/terminals/shell') {
      const body = await readBody(req);
      if (typeof body.run_id !== 'string' || !body.run_id) throw new ControlError('bad_request', 'run_id is required', 400);
      return ok({ terminal: terminals.shell(body.run_id) });
    }
    const terminalRoute = /^\/v1\/terminals\/([^/]+)(?:\/(lease|input|resize))?$/.exec(url.pathname);
    if (terminalRoute) {
      const terminalId = decodeURIComponent(terminalRoute[1]);
      const action = terminalRoute[2];
      if (req.method === 'GET' && !action) return ok(terminals.observe(terminalId, seqParam(url, 'after')));
      if (req.method === 'POST' && action) {
        const body = await readBody(req);
        if (action === 'lease') {
          if (body.action === 'acquire') return ok(terminals.acquire(terminalId, body.owner_id as string, body.ttl_ms === undefined ? undefined : Number(body.ttl_ms)));
          if (typeof body.lease_id !== 'string') throw new ControlError('bad_request', 'lease_id is required', 400);
          if (body.action === 'renew') { terminals.renew(terminalId, body.lease_id); return ok({}); }
          if (body.action === 'release') { terminals.release(terminalId, body.lease_id); return ok({}); }
          throw new ControlError('bad_request', 'Invalid lease action', 400);
        }
        if (typeof body.lease_id !== 'string') throw new ControlError('bad_request', 'lease_id is required', 400);
        if (action === 'input') { terminals.input(terminalId, body.lease_id, body.data as string); return ok({}); }
        if (action === 'resize') { terminals.resize(terminalId, body.lease_id, Number(body.columns), Number(body.rows)); return ok({}); }
      }
    }
    if (req.method === 'POST' && url.pathname === '/v1/commands') {
      const credential = actorCredential(req);
      const body = await readBody(req) as unknown as SubmitCommandRequest;
      assertOpen();
      for (const field of ['run_id', 'recipient_session_id', 'idempotency_key', 'kind'] as const) {
        if (typeof body[field] !== 'string' || !body[field]) throw new ControlError('bad_request', `${field} is required`, 400);
      }
      const command = commands.enqueue(credential, {
        runId: body.run_id, recipientSessionId: body.recipient_session_id, idempotencyKey: body.idempotency_key,
        kind: body.kind, payload: body.payload ?? null,
        ...(body.side_effecting === undefined ? {} : { sideEffecting: body.side_effecting }),
        ...(body.max_attempts === undefined ? {} : { maxAttempts: body.max_attempts }),
        ...(body.deadline_at === undefined ? {} : { deadlineAt: body.deadline_at }),
      });
      return ok({ command }, 202);
    }
    const ack = /^\/v1\/commands\/([^/]+)\/ack$/.exec(url.pathname);
    if (req.method === 'POST' && ack) {
      const credential = actorCredential(req);
      const body = await readBody(req);
      assertOpen();
      if (!ACK_STATES.has(body.state as AckState)) throw new ControlError('bad_request', 'state must be accepted, running, completed or failed', 400);
      return ok({ command: commands.acknowledge(credential, decodeURIComponent(ack[1]), body.state as AckState) });
    }
    throw new ControlError('not_found', `No route for ${req.method} ${url.pathname}`, 404);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
  });

  await clearStaleSocket(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  const terminalSweep = setInterval(() => {
    try { terminals.reconcile(); } catch { /* next sweep retries; requests still report errors */ }
  }, 5_000);
  terminalSweep.unref();
  chmodSync(socketPath, 0o600);
  const tokenPath = join(stateDir, CONTROL_TOKEN_FILE);
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const endpoint: ControlEndpoint = {
    protocol_version: CONTROL_PROTOCOL_VERSION, transport: 'unix', path: socketPath,
    pid: process.pid, started_at: new Date().toISOString(),
  };
  const endpointPath = join(stateDir, CONTROL_ENDPOINT_FILE);
  atomicWriteJson(endpointPath, endpoint);

  return {
    endpoint,
    // Endpoint cleanup is synchronous so a caller that exits right away leaves no stale descriptor.
    close: () => {
      closing = true;
      clearInterval(terminalSweep);
      for (const res of streams) res.destroy();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      let ours = true;
      try {
        const current = JSON.parse(readFileSync(endpointPath, 'utf8')) as ControlEndpoint;
        ours = current.pid === endpoint.pid && current.started_at === endpoint.started_at;
      } catch { /* missing descriptor */ }
      // Leave files alone if another daemon has since taken over the endpoint.
      if (ours) {
        for (const path of [endpointPath, tokenPath, socketPath]) {
          try { unlinkSync(path); } catch { /* already gone */ }
        }
      }
      return closed;
    },
  };
}
