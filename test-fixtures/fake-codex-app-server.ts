#!/usr/bin/env node
/**
 * Fake `codex app-server --listen stdio://` for runtime tests (task 203).
 * Speaks the subset of the JSON-RPC line protocol the structured runtime uses.
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
 *   FAKE_CODEX_NOISE=1          print a non-JSON line before the first frame
 */
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const env = process.env;
const record = (value: Record<string, unknown>) => {
  if (env.FAKE_CODEX_RECORD) appendFileSync(env.FAKE_CODEX_RECORD, `${JSON.stringify(value)}\n`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

record({
  kind: 'startup',
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  api_key_env: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'].filter((key) => env[key] !== undefined),
});

let writeChain = Promise.resolve();
function send(frame: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify(frame)}\n`;
  writeChain = writeChain.then(async () => {
    if (env.FAKE_CODEX_SPLIT_FRAMES !== '1') { process.stdout.write(line); return; }
    for (let index = 0; index < line.length; index += 7) {
      process.stdout.write(line.slice(index, index + 7));
      await sleep(1);
    }
  });
  return writeChain;
}

if (env.FAKE_CODEX_NOISE === '1') process.stdout.write('codex app-server: starting (not json)\n');

const threadId = `thread-${process.pid}`;
let turnSeq = 0;
let threadInstructions = '';
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
  await send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [], error: null } } });
  if (env.FAKE_CODEX_LATE_ITEM === '1') {
    await send({ method: 'item/completed', params: { ...base, item: { type: 'fileChange', id: `${turnId}-late`, status: 'completed' }, completedAtMs: Date.now() } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
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
  const reply = (result: unknown) => send({ id: frame.id, result });
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
      threadInstructions = typeof params.developerInstructions === 'string' ? params.developerInstructions : '';
      void reply({ thread: { id: params.threadId }, model: 'fake', modelProvider: 'openai', cwd: params.cwd ?? process.cwd() });
      return;
    case 'turn/start': {
      const turnId = `turn-${++turnSeq}`;
      const input = (params.input as Array<{ text?: string }> | undefined) ?? [];
      const text = input.map((entry) => entry.text ?? '').join('\n');
      const started = { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } } };
      const respond = { id: frame.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } };
      void (async () => {
        if (env.FAKE_CODEX_STARTED_FIRST === '1') { await send(started); await send(respond); } else { await send(respond); await send(started); }
        await runTurn(turnId, text);
      })();
      return;
    }
    default:
      if (frame.id !== undefined) void send({ id: frame.id, error: { code: -32601, message: `fake does not implement ${method}` } });
  }
});
