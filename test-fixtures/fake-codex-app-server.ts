#!/usr/bin/env node
/**
 * Fake `codex app-server --listen unix://PATH` for runtime tests (task 203).
 * Speaks the subset of the JSON-RPC protocol the structured runtime uses, one
 * message per WebSocket text frame. Like the real server it keeps running when
 * a client disconnects (turns go on; their notifications reach whoever is
 * connected), and a later client can reattach with thread/resume and read the
 * last turn with thread/turns/list.
 *
 * Knobs (env):
 *   FAKE_CODEX_ACCOUNT          chatgpt (default) | apiKey | none
 *   FAKE_CODEX_RECORD           file to append one JSON line per received frame (plus startup facts)
 *   FAKE_CODEX_SPLIT_FRAMES=1   write every frame in small chunks with pauses (partial frames)
 *   FAKE_CODEX_STARTED_FIRST=1  send turn/started before answering turn/start
 *   FAKE_CODEX_LATE_ITEM=1      send an item/completed for the turn after turn/completed
 *   FAKE_CODEX_APPROVAL=1       ask for command approval mid-turn and record the decision
 *   FAKE_CODEX_TURN_STATUS      final turn status (default completed)
 *   FAKE_CODEX_TURN_SCRIPT      shell command run per turn (cwd = server cwd; FAKE_TURN_TEXT = input text,
 *                               FAKE_THREAD_INSTRUCTIONS = the thread's developerInstructions)
 *   FAKE_CODEX_TURN_HOLD_MS     keep each turn running this long before completing
 *   FAKE_CODEX_NOISE=1          send a non-JSON text frame before the first protocol frame
 *   FAKE_CODEX_IGNORE_SIGTERM=1 ignore SIGTERM (stop must escalate to SIGKILL)
 *   FAKE_CODEX_NO_LIST_TURNS=1  like Codex 0.163 just after a turn starts: thread/turns/list and
 *                               thread/resume with excludeTurns fail ("list_turns is not supported yet"),
 *                               and a full thread/resume returns the turns without their user message
 */
import { appendFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { acceptKey, encodeFrame, FrameDecoder, OPCODE } from '../adapters/unixWebSocket.ts';

const env = process.env;
const record = (value: Record<string, unknown>) => {
  if (env.FAKE_CODEX_RECORD) appendFileSync(env.FAKE_CODEX_RECORD, `${JSON.stringify(value)}\n`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

record({
  kind: 'startup',
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  api_key_env: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'].filter((key) => env[key] !== undefined),
});

const clients = new Set<Socket>();

/** Write raw bytes to every connected client, in small pieces when FAKE_CODEX_SPLIT_FRAMES is set. */
let writeChain = Promise.resolve();
function sendText(text: string, only?: Socket): Promise<void> {
  const bytes = encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'), false);
  writeChain = writeChain.then(async () => {
    for (const client of only ? [only] : [...clients]) {
      if (client.destroyed) continue;
      if (env.FAKE_CODEX_SPLIT_FRAMES !== '1') { client.write(bytes); continue; }
      for (let index = 0; index < bytes.length; index += 7) {
        client.write(bytes.subarray(index, index + 7));
        await sleep(1);
      }
    }
  });
  return writeChain;
}
function send(frame: Record<string, unknown>, only?: Socket): Promise<void> {
  return sendText(JSON.stringify(frame), only);
}

const threadId = `thread-${process.pid}`;
let turnSeq = 0;
let threadInstructions = '';
/** Every turn, newest last, as thread/turns/list reports it. */
const turns: Array<{ id: string; status: string; clientId: string | null }> = [];
let serverRequestSeq = 1000;
const waitingServerRequests = new Map<number, (result: unknown) => void>();

function account(): unknown {
  if (env.FAKE_CODEX_ACCOUNT === 'apiKey') return { type: 'apiKey' };
  if (env.FAKE_CODEX_ACCOUNT === 'none') return null;
  return { type: 'chatgpt', email: null, planType: 'team' };
}

function askServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = serverRequestSeq++;
  const answered = new Promise<unknown>((resolve) => waitingServerRequests.set(id, resolve));
  void send({ id, method, params });
  return answered;
}

function runTurnScript(text: string): Promise<number> {
  if (!env.FAKE_CODEX_TURN_SCRIPT) return Promise.resolve(0);
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', env.FAKE_CODEX_TURN_SCRIPT!], { env: { ...env, FAKE_TURN_TEXT: text, FAKE_THREAD_INSTRUCTIONS: threadInstructions }, stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function runTurn(turnId: string, text: string): Promise<void> {
  const base = { threadId, turnId };
  await send({ method: 'item/started', params: { ...base, item: { type: 'commandExecution', id: `${turnId}-cmd`, command: 'echo work', status: 'inProgress' }, startedAtMs: Date.now() } });
  if (env.FAKE_CODEX_APPROVAL === '1') {
    const decision = await askServerRequest('item/commandExecution/requestApproval', { ...base, itemId: `${turnId}-cmd`, kind: 'command', startedAtMs: Date.now() });
    record({ kind: 'approval_response', result: decision });
  }
  const scriptExit = await runTurnScript(text);
  await send({ method: 'item/completed', params: { ...base, item: { type: 'commandExecution', id: `${turnId}-cmd`, command: 'echo work', status: 'completed' }, completedAtMs: Date.now() } });
  await send({ method: 'item/agentMessage/delta', params: { ...base, itemId: `${turnId}-msg`, delta: 'FAKE_CODEX_REPLY ' } });
  await send({ method: 'item/agentMessage/delta', params: { ...base, itemId: `${turnId}-msg`, delta: `turn=${turnId}` } });
  await send({ method: 'item/completed', params: { ...base, item: { type: 'agentMessage', id: `${turnId}-msg`, text: 'FAKE_CODEX_REPLY' }, completedAtMs: Date.now() } });
  const hold = Number.parseInt(env.FAKE_CODEX_TURN_HOLD_MS ?? '0', 10);
  if (hold > 0) await sleep(hold);
  const status = scriptExit === 0 ? (env.FAKE_CODEX_TURN_STATUS ?? 'completed') : 'failed';
  const entry = turns.find((turn) => turn.id === turnId);
  if (entry) entry.status = status;
  await send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [], error: null } } });
  if (env.FAKE_CODEX_LATE_ITEM === '1') {
    await send({ method: 'item/completed', params: { ...base, item: { type: 'fileChange', id: `${turnId}-late`, status: 'completed' }, completedAtMs: Date.now() } });
  }
}

function onMessage(client: Socket, line: string): void {
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }
  const method = typeof frame.method === 'string' ? frame.method : undefined;
  const params = (frame.params ?? {}) as Record<string, unknown>;
  record({ kind: 'frame', method: method ?? null, id: frame.id ?? null, params: method === 'turn/start' ? { ...params, input: undefined } : params });
  if (!method && typeof frame.id === 'number') {
    const resolve = waitingServerRequests.get(frame.id);
    waitingServerRequests.delete(frame.id);
    resolve?.(frame.result ?? { error: frame.error });
    return;
  }
  const reply = (result: unknown) => send({ id: frame.id, result }, client);
  switch (method) {
    case 'initialize': void reply({ userAgent: 'fake-codex/0.0.0' }); return;
    case 'initialized': return;
    case 'account/read': void reply({ account: account(), requiresOpenaiAuth: true }); return;
    case 'thread/start':
      threadInstructions = typeof params.developerInstructions === 'string' ? params.developerInstructions : '';
      void reply({ thread: { id: threadId }, model: 'fake', modelProvider: 'openai', cwd: params.cwd ?? process.cwd(), approvalPolicy: params.approvalPolicy, sandbox: { type: params.sandbox } });
      void send({ method: 'thread/started', params: { thread: { id: threadId } } });
      return;
    case 'thread/resume':
      if (env.FAKE_CODEX_NO_LIST_TURNS === '1' && params.excludeTurns === true && turns.length > 0) {
        void send({ id: frame.id, error: { code: -32601, message: 'list_turns is not supported yet' } }, client);
        return;
      }
      if (typeof params.developerInstructions === 'string') threadInstructions = params.developerInstructions;
      void reply({
        thread: {
          id: params.threadId,
          ...(params.excludeTurns === true ? {} : { turns: turns.map((turn) => ({ id: turn.id, status: turn.status, error: null, items: [], itemsView: 'notLoaded' })) }),
        },
        model: 'fake', modelProvider: 'openai', cwd: params.cwd ?? process.cwd() });
      return;
    case 'turn/start': {
      const turnId = `turn-${++turnSeq}`;
      turns.push({ id: turnId, status: 'inProgress', clientId: typeof params.clientUserMessageId === 'string' ? params.clientUserMessageId : null });
      const input = (params.input as Array<{ text?: string }> | undefined) ?? [];
      const text = input.map((entry) => entry.text ?? '').join('\n');
      const started = { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } } };
      const respond = { id: frame.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } };
      void (async () => {
        if (env.FAKE_CODEX_STARTED_FIRST === '1') { await send(started); await send(respond, client); } else { await send(respond, client); await send(started); }
        await runTurn(turnId, text);
      })();
      return;
    }
    case 'thread/turns/list': {
      if (env.FAKE_CODEX_NO_LIST_TURNS === '1') {
        void send({ id: frame.id, error: { code: -32601, message: 'list_turns is not supported yet' } }, client);
        return;
      }
      const newest = [...turns].reverse().slice(0, typeof params.limit === 'number' ? params.limit : turns.length);
      void reply({
        data: newest.map((turn) => ({
          id: turn.id, status: turn.status, error: null, itemsView: 'full',
          items: [{ type: 'userMessage', id: `${turn.id}-user`, clientId: turn.clientId, content: [] }],
        })),
        nextCursor: null, backwardsCursor: null,
      });
      return;
    }
    default:
      if (frame.id !== undefined) void send({ id: frame.id, error: { code: -32601, message: `fake does not implement ${method}` } }, client);
  }
}

/** WebSocket upgrade, then one JSON-RPC message per text frame. */
function onConnection(client: Socket): void {
  let header = Buffer.alloc(0);
  let decoder: FrameDecoder | null = null;
  const deliver = (chunk: Buffer) => {
    for (const message of decoder!.push(chunk)) {
      if (message.opcode === OPCODE.text) onMessage(client, message.payload.toString('utf8'));
      else if (message.opcode === OPCODE.close) client.end();
    }
  };
  client.on('data', (chunk: Buffer) => {
    if (decoder) { deliver(chunk); return; }
    header = Buffer.concat([header, chunk]);
    const end = header.indexOf('\r\n\r\n');
    if (end === -1) return;
    const key = header.subarray(0, end).toString('latin1').split('\r\n')
      .find((line) => line.toLowerCase().startsWith('sec-websocket-key:'))?.slice(18).trim() ?? '';
    client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    decoder = new FrameDecoder();
    clients.add(client);
    record({ kind: 'connection', count: clients.size });
    if (env.FAKE_CODEX_NOISE === '1') void sendText('codex app-server: connected (not json)', client);
    const rest = header.subarray(end + 4);
    if (rest.length) deliver(rest);
  });
  client.on('close', () => { clients.delete(client); });
  client.on('error', () => { clients.delete(client); });
}

const listen = process.argv[process.argv.indexOf('--listen') + 1] ?? '';
if (!listen.startsWith('unix://')) {
  process.stderr.write(`fake codex app-server supports only --listen unix://PATH (got ${listen})\n`);
  process.exit(2);
}
const socketFile = listen.slice('unix://'.length);
rmSync(socketFile, { force: true });
createServer(onConnection).listen(socketFile);
process.on('SIGTERM', () => {
  if (env.FAKE_CODEX_IGNORE_SIGTERM === '1') { record({ kind: 'sigterm_ignored' }); return; }
  rmSync(socketFile, { force: true });
  process.exit(143);
});
