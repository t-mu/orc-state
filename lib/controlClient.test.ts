import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { ControlClient, type CallOptions } from './controlClient.ts';
import {
  CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_PROTOCOL_VERSIONS, CONTROL_TOKEN_FILE, ControlError, PROTOCOL_HEADER, defaultSocketPath,
} from './controlProtocol.ts';

/** A fake coordinator on a Unix socket; each test sets `handler`. */
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let dir: string;
let server: Server;
let handler: Handler;

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const okBody = (result: unknown) => ({ protocol_version: CONTROL_PROTOCOL_VERSION, ok: true, result });
const hang: Handler = () => { /* never answers */ };

async function drainAll<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

beforeEach(async () => {
  dir = createTempStateDir('orc-control-client-');
  const socketPath = defaultSocketPath(dir);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  writeFileSync(join(dir, CONTROL_ENDPOINT_FILE), JSON.stringify({
    protocol_version: CONTROL_PROTOCOL_VERSION, transport: 'unix', path: socketPath, pid: process.pid, started_at: new Date().toISOString(),
  }));
  writeFileSync(join(dir, CONTROL_TOKEN_FILE), 'test-token');
  handler = (_req, res) => json(res, 200, okBody({}));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTempStateDir(dir);
});

/** Every request/response method, called with the per-call options as its last argument. */
const METHODS: Array<[string, (client: ControlClient, options: CallOptions) => Promise<unknown>]> = [
  ['health', (c, o) => c.health(o)],
  ['snapshot', (c, o) => c.snapshot(o)],
  ['runs', (c, o) => c.runs({}, o)],
  ['status', (c, o) => c.status({}, o)],
  ['messages', (c, o) => c.messages(false, o)],
  ['sendMessage', (c, o) => c.sendMessage({ runId: 'r', recipientSessionId: 's', idempotencyKey: 'k', kind: 'note', text: 't' } as never, o)],
  ['consumeMessage', (c, o) => c.consumeMessage('m', o)],
  ['events', (c, o) => c.events(0, 10, {}, o)],
  ['run', (c, o) => c.run('r', o)],
  ['submitCommand', (c, o) => c.submitCommand({ run_id: 'r', recipient_session_id: 's', idempotency_key: 'k', kind: 'x', payload: null }, o)],
  ['acknowledge', (c, o) => c.acknowledge('c', 'accepted', o)],
  ['lifecycle', (c, o) => c.lifecycle({ op: 'memory-record', content: 'x' } as never, o)],
  ['reviews', (c, o) => c.reviews('r', o)],
  ['stopCheck', (c, o) => c.stopCheck(false, o)],
  ['memoryWakeUp', (c, o) => c.memoryWakeUp({}, o)],
  ['operator', (c, o) => c.operator({ op: 'reset-task', task_ref: 'a/b' } as never, o)],
  ['listTasks', (c, o) => c.listTasks({}, o)],
  ['getTask', (c, o) => c.getTask('a/b', o)],
  ['taskRevisions', (c, o) => c.taskRevisions('a/b', o)],
  ['createTask', (c, o) => c.createTask({ feature: 'a', title: 'b' }, undefined, o)],
  ['reviseTask', (c, o) => c.reviseTask('a/b', 1, {}, undefined, o)],
  ['importTasks', (c, o) => c.importTasks([], false, undefined, o)],
  ['importPlans', (c, o) => c.importPlans([], undefined, o)],
  ['scoutReport', (c, o) => c.scoutReport('s', o)],
  ['openTerminal', (c, o) => c.openTerminal('provider', 'r', o)],
  ['sessions', (c, o) => c.sessions(o)],
  ['acquireTerminal', (c, o) => c.acquireTerminal('t', 'me', {}, o)],
  ['renewTerminal', (c, o) => c.renewTerminal('t', 'l', o)],
  ['releaseTerminal', (c, o) => c.releaseTerminal('t', 'l', o)],
  ['inputTerminal', (c, o) => c.inputTerminal('t', 'l', 'x', o)],
  ['resizeTerminal', (c, o) => c.resizeTerminal('t', 'l', 80, 24, o)],
];

/** The stream methods, drained to an array. */
const STREAMS: Array<[string, (client: ControlClient, options: CallOptions) => Promise<unknown[]>]> = [
  ['subscribe', (c, o) => drainAll(c.subscribe(0, o))],
  ['streamTerminal', (c, o) => drainAll(c.streamTerminal('t', {}, o))],
];

describe('ControlClient per-call options', () => {
  it.each(METHODS)('%s: a per-call timeout rejects with ControlError("timeout")', async (_name, call) => {
    handler = hang;
    const started = Date.now();
    const error = await call(new ControlClient(dir), { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlError);
    expect(error).toMatchObject({ code: 'timeout', status: 504 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each(METHODS)('%s: aborting destroys the request and rejects with ControlError("aborted")', async (_name, call) => {
    let closed!: () => void;
    const requestClosed = new Promise<void>((resolve) => { closed = resolve; });
    handler = (req) => { req.socket.on('close', () => closed()); };
    const abort = new AbortController();
    const pending = call(new ControlClient(dir), { signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await requestClosed;
    // An already-aborted signal never sends.
    await expect(call(new ControlClient(dir), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' });
  });

  it.each(STREAMS)('%s: abort ends the stream quietly; a per-call timeout bounds opening it', async (_name, drain) => {
    handler = hang;
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    await expect(drain(new ControlClient(dir), { signal: abort.signal })).resolves.toEqual([]);
    await expect(drain(new ControlClient(dir), { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('gives import a longer default than the client timeout, and a call timeout overrides the client one', async () => {
    handler = (_req, res) => { setTimeout(() => json(res, 200, okBody({ imported: [] })), 150); };
    const client = new ControlClient(dir, { timeoutMs: 50 });
    await expect(client.importTasks([])).resolves.toEqual({ imported: [] });
    await expect(client.importPlans([])).resolves.toEqual({ imported: [] });
    await expect(client.snapshot()).rejects.toMatchObject({ code: 'timeout' });
    await expect(client.snapshot({ timeoutMs: 2_000 })).resolves.toEqual({ imported: [] });
    await expect(client.importTasks([], false, undefined, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('ControlClient error bodies', () => {
  it('turns a non-JSON or empty error body into a ControlError with the status and an excerpt', async () => {
    handler = (_req, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>\n  Bad   Gateway</html>'); };
    const error = await new ControlClient(dir).snapshot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    // It reached a server, so it is never `unavailable` (which callers retry as unsent).
    expect(error).toMatchObject({ code: 'internal', status: 502, message: expect.stringContaining('<html> Bad Gateway</html>') });

    handler = (_req, res) => { res.writeHead(400); res.end(); };
    await expect(new ControlClient(dir).snapshot()).rejects.toMatchObject({ code: 'internal', status: 400, message: expect.stringContaining('an empty body') });

    handler = (_req, res) => { res.writeHead(500); res.end('x'.repeat(5_000)); };
    const long = await new ControlClient(dir).snapshot().catch((e: unknown) => e) as ControlError;
    expect(long).toBeInstanceOf(ControlError);
    expect(long.message.length).toBeLessThan(400);

    // JSON that is not a control envelope is not trusted either.
    handler = (_req, res) => json(res, 500, null);
    await expect(new ControlClient(dir).snapshot()).rejects.toBeInstanceOf(ControlError);
    handler = (_req, res) => json(res, 400, { ok: false });
    await expect(new ControlClient(dir).snapshot()).rejects.toBeInstanceOf(ControlError);
  });

  it('maps a non-JSON stream open failure to ControlError', async () => {
    handler = (_req, res) => { res.writeHead(404); res.end('not here'); };
    await expect(drainAll(new ControlClient(dir).subscribe(0))).rejects.toMatchObject({ code: 'internal', status: 404, message: expect.stringContaining('not here') });
    handler = (_req, res) => { res.writeHead(503); res.end('down'); };
    await expect(drainAll(new ControlClient(dir).subscribe(0))).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  });
});

describe('ControlClient terminal input ordering', () => {
  it('sends concurrent inputs to one terminal one at a time, in call order', async () => {
    const arrivals: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    handler = (_req, res, body) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const { data } = JSON.parse(body) as { data: string };
      arrivals.push(data);
      // Earlier inputs answer slower: without the queue the later ones would overtake them.
      setTimeout(() => { inFlight -= 1; json(res, 200, okBody(null)); }, 60 - Number(data) * 10);
    };
    const client = new ControlClient(dir);
    const order = ['0', '1', '2', '3', '4'];
    await Promise.all(order.map((data) => client.inputTerminal('t1', 'lease', data)));
    expect(arrivals).toEqual(order);
    expect(maxInFlight).toBe(1);
  });

  it('keeps sending after a failed input, and an aborted queued input is never sent', async () => {
    const arrivals: string[] = [];
    handler = (_req, res, body) => {
      const { data } = JSON.parse(body) as { data: string };
      arrivals.push(data);
      setTimeout(() => {
        if (data === 'bad') json(res, 403, { protocol_version: 1, ok: false, error: { code: 'forbidden', message: 'no lease' } });
        else json(res, 200, okBody(null));
      }, 40);
    };
    const client = new ControlClient(dir);
    const abort = new AbortController();
    const first = client.inputTerminal('t1', 'lease', 'bad');
    const skipped = client.inputTerminal('t1', 'lease', 'skipped', { signal: abort.signal });
    const last = client.inputTerminal('t1', 'lease', 'last');
    abort.abort();
    await expect(skipped).rejects.toMatchObject({ code: 'aborted' });
    await expect(first).rejects.toMatchObject({ code: 'forbidden' });
    await last;
    expect(arrivals).toEqual(['bad', 'last']);
  });

  it('does not serialise inputs to different terminals', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    handler = (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => { inFlight -= 1; json(res, 200, okBody(null)); }, 40);
    };
    const client = new ControlClient(dir);
    await Promise.all([client.inputTerminal('t1', 'l', 'a'), client.inputTerminal('t2', 'l', 'b')]);
    expect(maxInFlight).toBe(2);
  });
});

describe('ControlClient protocol negotiation', () => {
  const refuse = (res: ServerResponse): void => json(res, 400, {
    protocol_version: 3, ok: false, error: { code: 'unsupported_protocol_version', message: 'Unsupported protocol version 1; this coordinator supports [2, 3]' },
  });

  it('asks /v1/health after a version refusal and names both ranges', async () => {
    const healthHeaders: Array<string | undefined> = [];
    handler = (req, res) => {
      if (req.url === '/v1/health') {
        healthHeaders.push(req.headers[PROTOCOL_HEADER] as string | undefined);
        json(res, 200, okBody({ protocol_version: 3, protocol_versions: [2, 3] }));
      } else refuse(res);
    };
    const error = await new ControlClient(dir).snapshot().catch((e: unknown) => e) as ControlError;
    expect(error).toBeInstanceOf(ControlError);
    expect(error.code).toBe('unsupported_protocol_version');
    expect(error.message).toContain('coordinator supports versions [2, 3]');
    expect(error.message).toContain(`this client supports [${CONTROL_PROTOCOL_VERSIONS[0]}, ${CONTROL_PROTOCOL_VERSIONS[1]}]`);
    expect(healthHeaders).toHaveLength(1);
    // Streams negotiate the same way.
    await expect(drainAll(new ControlClient(dir).subscribe(0))).rejects.toMatchObject({
      code: 'unsupported_protocol_version', message: expect.stringContaining('[2, 3]'),
    });
  });

  it('says the coordinator range is unknown when /v1/health does not answer with one', async () => {
    handler = (_req, res) => refuse(res);
    const error = await new ControlClient(dir).snapshot().catch((e: unknown) => e) as ControlError;
    expect(error).toMatchObject({ code: 'unsupported_protocol_version' });
    expect(error.message).toContain('unknown range');
    expect(error.message).toContain(`this client supports [${CONTROL_PROTOCOL_VERSIONS[0]}, ${CONTROL_PROTOCOL_VERSIONS[1]}]`);
  });

  it('keeps the health lookup within the call timeout', async () => {
    handler = (req, res) => { if (req.url !== '/v1/health') refuse(res); };
    const started = Date.now();
    const error = await new ControlClient(dir).snapshot({ timeoutMs: 200 }).catch((e: unknown) => e) as ControlError;
    expect(error).toMatchObject({ code: 'unsupported_protocol_version', message: expect.stringContaining('unknown range') });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports a transport mismatch without negotiating a version', async () => {
    let requests = 0;
    handler = (_req, res) => { requests += 1; json(res, 200, okBody({})); };
    writeFileSync(join(dir, CONTROL_ENDPOINT_FILE), JSON.stringify({
      protocol_version: 1, transport: 'tcp', path: defaultSocketPath(dir), pid: process.pid, started_at: new Date().toISOString(),
    }));
    const error = await new ControlClient(dir).snapshot().catch((e: unknown) => e) as ControlError;
    expect(error).toMatchObject({ code: 'unsupported_protocol_version', message: expect.stringContaining('transport tcp') });
    expect(error.message).not.toContain('mismatch');
    expect(requests).toBe(0);
  });

  it('does not refuse a descriptor written by a coordinator of another protocol version', async () => {
    writeFileSync(join(dir, CONTROL_ENDPOINT_FILE), JSON.stringify({
      protocol_version: 99, transport: 'unix', path: defaultSocketPath(dir), pid: process.pid, started_at: new Date().toISOString(),
    }));
    handler = (_req, res) => json(res, 200, okBody({ runs: [] }));
    await expect(new ControlClient(dir).snapshot()).resolves.toEqual({ runs: [] });
  });
});
