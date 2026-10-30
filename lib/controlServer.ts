import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { CommandDispatcher, type CommandAuthenticator } from './commandDelivery.ts';
import {
  CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE, ControlError, OPERATOR_TOKEN_FILE,
  OPERATOR_HEADER, PROTOCOL_HEADER, SESSION_HEADER, defaultSocketPath,
  type AckState, type ControlEndpoint, type StreamFrame, type SubmitCommandRequest,
} from './controlProtocol.ts';
import { readEventBatch } from './eventLog.ts';
import { readControlSnapshot } from './statusProjection.ts';
import { TerminalBroker } from './terminalBroker.ts';
import { consumeMessage, listMessages, sendMessage, type SendMessageInput } from './messageRouter.ts';
import { resolveControlPrincipal, requirePrincipal, requireProjectAuthor, requireProjectReader, type ControlPrincipal } from './controlPrincipal.ts';
import { ConflictError, ForbiddenError, InputError, NotFoundError, UnauthenticatedError } from './domainErrors.ts';
import { RevisionConflictError } from './projectTaskStore.ts';
import { createProjectTask, describeProjectTask, projectTaskStoreFor, reviseProjectTask, TaskInputError } from './projectTasks.ts';
import { applyLifecycle, authorizeLifecycle, parseLifecycleRequest } from './workerLifecycle.ts';
import { applyOperatorMutation, authorizeOperator, parseOperatorRequest } from './operatorMutations.ts';
import { importTaskMarkdownSources, type TaskMarkdownSource } from './taskMarkdown.ts';
import { DEFAULT_WAKE_UP_BUDGET, isWakeUpBudget, readMemoryWakeUp, readRunReviews } from './projectReads.ts';

const MAX_BODY_BYTES = 1024 * 1024;
/** A whole backlog directory travels as text in one import request. */
const MAX_IMPORT_BODY_BYTES = 32 * 1024 * 1024;
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
 * A running session's secret is the caller's actor credential (task 231): a
 * project accepts only that, so a session id read from the state directory
 * proves nothing. A legacy installation also accepts the id of a session
 * recorded without a secret. Same-user processes can still open the state
 * databases directly; the provider sandbox, not this check, stops that.
 */
export function sessionAuthenticator(stateDir: string): CommandAuthenticator {
  return (credential) => {
    try {
      const principal = resolveControlPrincipal(stateDir, credential, false);
      return principal && principal.kind !== 'operator' && principal.running
        ? { agentId: principal.agentId, sessionId: principal.sessionId } : null;
    } catch (error) {
      if (error instanceof ControlError && error.code === 'unauthenticated') return null;
      throw error;
    }
  };
}

/** Map storage-neutral task API failures to protocol errors; anything unexpected is internal. */
function taskError(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RevisionConflictError || error instanceof ConflictError) return new ControlError('conflict', message, 409);
  if (error instanceof NotFoundError) return new ControlError('not_found', message, 404);
  if (error instanceof TaskInputError || error instanceof InputError) return new ControlError('bad_request', message, 400);
  return classify(error);
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }

function classify(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NotFoundError) return new ControlError('not_found', message, 404);
  if (error instanceof ConflictError || error instanceof RevisionConflictError) return new ControlError('conflict', message, 409);
  if (error instanceof InputError || error instanceof TaskInputError) return new ControlError('bad_request', message, 400);
  if (error instanceof ForbiddenError) return new ControlError('forbidden', message, 403);
  if (error instanceof UnauthenticatedError) return new ControlError('unauthenticated', message, 401);
  return new ControlError('internal', message, 500);
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ControlError('bad_request', `Malformed path segment: ${segment}`, 400);
  }
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

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ControlError('bad_request', 'Request body too large', 413);
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

function actorField(body: Record<string, unknown>): string | undefined {
  if (body.actor_id !== undefined && typeof body.actor_id !== 'string') throw new InputError('actor_id must be a string');
  return body.actor_id;
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
  const operatorToken = randomBytes(32).toString('hex');
  const operatorDigest = digest(operatorToken);
  const isOperator = (req: IncomingMessage): boolean => {
    const presented = req.headers[OPERATOR_HEADER];
    return typeof presented === 'string' && presented.length > 0 && timingSafeEqual(digest(presented), operatorDigest);
  };
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

  /**
   * Who reads a worker-facing route: a session (by its secret) or the
   * operator (by its token); the bearer token alone is not enough. `runId` is
   * the run a worker session is limited to, null for the master and the operator.
   */
  function principal(req: IncomingMessage): ControlPrincipal | null {
    const credential = req.headers[SESSION_HEADER];
    return resolveControlPrincipal(stateDir, typeof credential === 'string' && credential ? credential : null, isOperator(req));
  }

  /**
   * Whole-project reads (snapshot, events) and terminals belong to the master
   * and the operator. A worker session sees only its own run through the
   * scoped routes, so it is refused here even though it holds the bearer token.
   */
  function projectReader(req: IncomingMessage): void {
    requireProjectReader(principal(req));
  }

  /** Messages, like commands, need a running session: the operator and a recoverable or unknown session are not authenticated for them. */
  function messageSession(req: IncomingMessage): Extract<ControlPrincipal, { kind: 'worker' | 'master' }> {
    const caller = principal(req);
    if (!caller || caller.kind === 'operator' || !caller.running) throw new ControlError('unauthenticated', 'Messages require a running session', 401);
    return caller;
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
    if (req.method === 'GET' && url.pathname === '/v1/snapshot') {
      projectReader(req);
      return ok(readControlSnapshot(stateDir));
    }
    if (url.pathname === '/v1/messages') {
      const caller = messageSession(req);
      const messageActor = { agentId: caller.agentId, sessionId: caller.sessionId };
      if (req.method === 'GET') return ok({ messages: listMessages(stateDir, messageActor, url.searchParams.get('include_consumed') === '1') });
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.run_id !== 'string' || typeof body.recipient_session_id !== 'string' || typeof body.idempotency_key !== 'string'
          || typeof body.kind !== 'string' || typeof body.text !== 'string') throw new ControlError('bad_request', 'Message fields are required', 400);
        const input: SendMessageInput = { runId: body.run_id, recipientSessionId: body.recipient_session_id,
          idempotencyKey: body.idempotency_key, kind: body.kind as SendMessageInput['kind'], text: body.text,
          ...(body.artifact_refs === undefined ? {} : { artifactRefs: body.artifact_refs as string[] }),
          ...(body.parent_message_id === undefined ? {} : { parentMessageId: body.parent_message_id as string }),
        };
        return ok({ message: sendMessage(stateDir, messageActor, input, commands) }, 202);
      }
    }
    const messageAck = /^\/v1\/messages\/([^/]+)\/consume$/.exec(url.pathname);
    if (req.method === 'POST' && messageAck) {
      const caller = messageSession(req);
      return ok({ message: consumeMessage(stateDir, { agentId: caller.agentId, sessionId: caller.sessionId }, decodeURIComponent(messageAck[1])) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      projectReader(req);
      const after = seqParam(url, 'after');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ControlError('bad_request', 'limit must be between 1 and 1000', 400);
      const rows = readEventBatch(join(stateDir, 'events.db'), after, limit);
      return ok({ events: rows, cursor: rows.at(-1)?.seq ?? after });
    }
    const reviews = /^\/v1\/runs\/([^/]+)\/reviews$/.exec(url.pathname);
    if (req.method === 'GET' && reviews) {
      const runId = decodePathSegment(reviews[1]);
      // A worker session reads only its own run's reviews; the operator and the master read any.
      const reader = requirePrincipal(principal(req));
      if (reader.runId !== null && reader.runId !== runId) throw new ControlError('forbidden', `Session is not scoped to run ${runId}`, 403);
      return ok({ reviews: readRunReviews(stateDir, runId) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/memory/wake-up') {
      // Memories belong to the project: any authenticated session or the operator reads them.
      requirePrincipal(principal(req));
      const budget = Number(url.searchParams.get('budget') ?? DEFAULT_WAKE_UP_BUDGET);
      if (!isWakeUpBudget(budget)) throw new ControlError('bad_request', 'budget must be a positive integer', 400);
      return ok(readMemoryWakeUp(stateDir, { wing: url.searchParams.get('wing'), budget }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/events/stream') {
      projectReader(req);
      return stream(res, seqParam(url, 'after'));
    }
    // A terminal (a worker's provider session, or a shell the coordinator starts outside any sandbox) is never a worker's to open.
    if (url.pathname.startsWith('/v1/terminals/')) projectReader(req);
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
    if (url.pathname === '/v1/tasks' || url.pathname.startsWith('/v1/tasks/')) {
      const store = projectTaskStoreFor(stateDir);
      if (!store) throw new ControlError('not_found', 'Task API requires a project state directory', 404);
      if (req.method === 'POST' && url.pathname === '/v1/tasks/import') {
        // Authorize before reading a body; the specs arrive as text, so the coordinator never opens a caller's path.
        const caller = requireProjectReader(principal(req));
        const body = await readBody(req, MAX_IMPORT_BODY_BYTES);
        const actor = requireProjectAuthor(stateDir, caller, actorField(body));
        if (!Array.isArray(body.files) || body.files.some((file: unknown) => !file || typeof file !== 'object'
          || typeof (file as Record<string, unknown>).path !== 'string' || typeof (file as Record<string, unknown>).text !== 'string')) {
          throw new InputError('files must be a list of { path, text }');
        }
        if (body.strict !== undefined && typeof body.strict !== 'boolean') throw new InputError('strict must be a boolean');
        assertOpen();
        try {
          return ok({ imported: importTaskMarkdownSources(stateDir, body.files as TaskMarkdownSource[], { strict: body.strict === true, actorId: actor }) });
        } catch (error) {
          throw taskError(error);
        }
      }
      const match = /^\/v1\/tasks(?:\/([^/]+)(\/revisions)?)?$/.exec(url.pathname);
      if (!match) throw new ControlError('not_found', `No route for ${req.method} ${url.pathname}`, 404);
      const ref = match[1] === undefined ? null : decodeURIComponent(match[1]);
      try {
        if (req.method === 'GET') projectReader(req);
        if (req.method === 'GET' && ref === null) return ok({ tasks: store.listTasks().map(describeProjectTask) });
        if (req.method === 'GET' && !match[2]) {
          const task = store.getTask(ref!);
          if (!task) throw new NotFoundError(`Task not found: ${ref}`);
          return ok({ task: describeProjectTask(task) });
        }
        if (req.method === 'GET') {
          if (!store.getTask(ref!)) throw new NotFoundError(`Task not found: ${ref}`);
          return ok({ revisions: store.listRevisions(ref!) });
        }
        if (req.method === 'POST') {
          const caller = requireProjectReader(principal(req));
          const body = await readBody(req);
          const actor = requireProjectAuthor(stateDir, caller, actorField(body));
          delete body.actor_id;
          assertOpen();
          if (ref === null) return ok({ task: describeProjectTask(createProjectTask(stateDir, body, actor)) }, 201);
          if (match[2]) {
            const { expected_revision: expectedRevision, ...changes } = body;
            const { task, changed } = reviseProjectTask(stateDir, ref, expectedRevision, changes, actor);
            return ok({ task: describeProjectTask(task), changed });
          }
        }
      } catch (error) {
        throw taskError(error);
      }
      throw new ControlError('not_found', `No route for ${req.method} ${url.pathname}`, 404);
    }
    if (req.method === 'POST' && url.pathname === '/v1/lifecycle') {
      const credential = actorCredential(req);
      const request = parseLifecycleRequest(await readBody(req));
      assertOpen();
      const { live } = authorizeLifecycle(stateDir, credential, request);
      // An ended session may still poll, but never renews a lease (a superseded session's run may be someone else's now).
      const scoped = !live && request.op === 'input-poll' ? { ...request, heartbeat: false } : request;
      return ok(applyLifecycle(stateDir, scoped));
    }
    if (req.method === 'POST' && url.pathname === '/v1/operator') {
      const request = parseOperatorRequest(await readBody(req));
      assertOpen();
      const { actorId } = authorizeOperator(stateDir, principal(req), request);
      return ok(applyOperatorMutation(stateDir, { ...request, actor_id: actorId }));
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
  const operatorTokenPath = join(stateDir, OPERATOR_TOKEN_FILE);
  writeFileSync(operatorTokenPath, operatorToken, { mode: 0o600 });
  chmodSync(operatorTokenPath, 0o600);
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
        for (const path of [endpointPath, tokenPath, operatorTokenPath, socketPath]) {
          try { unlinkSync(path); } catch { /* already gone */ }
        }
      }
      return closed;
    },
  };
}
