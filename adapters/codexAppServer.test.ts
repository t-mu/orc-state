import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import type { RuntimeEvent } from './runtime.ts';

const fixtureBin = resolve(import.meta.dirname, '..', 'test-fixtures', 'bin');
const FAKE_KEYS = ['FAKE_CODEX_ACCOUNT', 'FAKE_CODEX_SPLIT_FRAMES', 'FAKE_CODEX_STARTED_FIRST', 'FAKE_CODEX_LATE_ITEM',
  'FAKE_CODEX_APPROVAL', 'FAKE_CODEX_TURN_STATUS', 'FAKE_CODEX_TURN_HOLD_MS', 'FAKE_CODEX_NOISE', 'FAKE_CODEX_TURN_SCRIPT'];

let dir: string;
let worktree: string;
let recordFile: string;
let originalPath: string | undefined;
const started: Array<{ stop: (handle: string) => Promise<void>; handle: string }> = [];

async function loadAdapter() {
  const module = await import('./codexAppServer.ts');
  const adapter = module.createCodexAppServerAdapter();
  const events: RuntimeEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  return { module, adapter, events };
}

async function startSession(adapter: Awaited<ReturnType<typeof loadAdapter>>['adapter'], config: Record<string, unknown> = {}) {
  const result = await adapter.start('worker-1', { working_directory: worktree, system_prompt: 'BOOTSTRAP', ...config });
  started.push({ stop: adapter.stop, handle: result.session_handle });
  return result;
}

function records(): Array<Record<string, unknown>> {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function frames(method: string): Array<Record<string, unknown>> {
  return records().filter((entry) => entry.kind === 'frame' && entry.method === method);
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const turnEvents = (events: RuntimeEvent[], turnId: string) => events.filter((event) => event.turn_id === turnId).map((event) => event.type);

beforeEach(() => {
  vi.resetModules();
  dir = createTempStateDir('orc-codex-app-');
  worktree = join(dir, 'worktree');
  mkdirSync(worktree);
  recordFile = join(dir, 'fake-record.jsonl');
  process.env.ORC_STATE_DIR = dir;
  process.env.FAKE_CODEX_RECORD = recordFile;
  originalPath = process.env.PATH;
  process.env.PATH = `${fixtureBin}:${originalPath}`;
});

afterEach(async () => {
  for (const entry of started.splice(0)) await entry.stop(entry.handle);
  process.env.PATH = originalPath;
  delete process.env.ORC_STATE_DIR;
  delete process.env.FAKE_CODEX_RECORD;
  for (const key of FAKE_KEYS) delete process.env[key];
  delete process.env.OPENAI_API_KEY;
  cleanupTempStateDir(dir);
});

describe('JsonLineDecoder', () => {
  it('reassembles partial frames, splits batched frames and skips non-JSON lines', async () => {
    const { JsonLineDecoder } = await import('./codexAppServer.ts');
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"id":1,"res')).toEqual([]);
    expect(decoder.push('ult":{}}\nnot json\n{"method":"a"}\n{"method"')).toEqual([{ id: 1, result: {} }, { method: 'a' }]);
    expect(decoder.push(':"b"}\n[1,2]\n')).toEqual([{ method: 'b' }]);
  });
});

describe('codex app-server runtime: session start', () => {
  it('handshakes in the worktree, declares capabilities and reports protocol readiness', async () => {
    const { adapter, events } = await loadAdapter();
    const result = await startSession(adapter);

    expect(result.session_handle).toBe('app:worker-1');
    expect(result.provider_ref).toMatchObject({ provider: 'codex', transport: 'app-server', protocol_ready: true, thread_id: expect.stringMatching(/^thread-/) });
    expect(adapter.capabilities).toEqual({ structured_events: true, command_ack: true, resume: true, steer: false, interrupt: false, approvals: false });
    expect(records().find((entry) => entry.kind === 'startup')).toMatchObject({ cwd: realpathSync(worktree) });
    expect(frames('initialize')).toHaveLength(1);
    expect(frames('account/read')).toHaveLength(1);
    expect(frames('thread/start')[0].params).toMatchObject({
      approvalPolicy: 'never', sandbox: 'danger-full-access', developerInstructions: 'BOOTSTRAP', cwd: worktree,
    });
    expect(events.map((event) => event.type)).toEqual(['session_ready']);
    expect(events[0].provider_meta).toMatchObject({ plan_type: 'team', resumed: false });
    expect(adapter.inspectSession(result.session_handle)).toMatchObject({ transport: 'app-server', alive: true, writable: true });
  });

  it('strips API-key billing variables from the provider environment', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    const { adapter } = await loadAdapter();
    await startSession(adapter, { env: { CODEX_API_KEY: 'also-not-real' } });
    expect(records().find((entry) => entry.kind === 'startup')).toMatchObject({ api_key_env: [] });
  });

  it.each([
    ['apiKey', 'is not a ChatGPT subscription login'],
    ['none', 'no Codex login'],
  ])('refuses to start a thread for a %s account', async (accountType, message) => {
    process.env.FAKE_CODEX_ACCOUNT = accountType;
    const { adapter } = await loadAdapter();
    await expect(adapter.start('worker-1', { working_directory: worktree })).rejects.toMatchObject({
      name: 'UnverifiedAuthError', code: 'unverified_auth', message: expect.stringContaining(message),
    });
    expect(frames('thread/start')).toEqual([]);
    expect(adapter.inspectSession('app:worker-1').alive).toBe(false);
  });

  it('maps execution modes to app-server sandbox policies with explicit writable roots', async () => {
    const { adapter } = await loadAdapter();
    await startSession(adapter, { execution_mode: 'sandbox' });
    const params = frames('thread/start')[0].params as Record<string, unknown>;
    expect(params.sandbox).toBe('workspace-write');
    expect((params.config as Record<string, string[]>)['sandbox_workspace_write.writable_roots']).toContain(dir);

    await adapter.stop('app:worker-1');
    await startSession(adapter, { execution_mode: 'sandbox', read_only: true });
    expect(frames('thread/start')[1].params).toMatchObject({ sandbox: 'read-only' });
  });

  it('resumes an existing provider thread when asked', async () => {
    const { adapter, events } = await loadAdapter();
    const result = await startSession(adapter, { resume_thread_id: 'thread-earlier' });
    expect(frames('thread/start')).toEqual([]);
    expect(frames('thread/resume')[0].params).toMatchObject({ threadId: 'thread-earlier', excludeTurns: true });
    expect(result.provider_ref).toMatchObject({ thread_id: 'thread-earlier' });
    expect(events[0].provider_meta).toMatchObject({ resumed: true });
  });

  it('fails clearly for a missing worktree without spawning', async () => {
    const { adapter } = await loadAdapter();
    await expect(adapter.start('worker-1', { working_directory: join(dir, 'missing') })).rejects.toThrow('assigned working directory does not exist');
    expect(records()).toEqual([]);
  });
});

describe('codex app-server runtime: turns and ACKs', () => {
  it('ACKs a submission with the provider turn id and attributes the turn to the command', async () => {
    const { adapter, events } = await loadAdapter();
    const { session_handle } = await startSession(adapter);

    const ack = await adapter.submit(session_handle, 'TASK_START', { commandId: 'cmd-1' });
    expect(ack).toEqual({ turn_id: 'turn-1', mode: 'started' });
    expect(frames('turn/start')[0].params).toMatchObject({ clientUserMessageId: 'cmd-1' });

    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    expect(turnEvents(events, 'turn-1')).toEqual(['turn_started', 'tool_started', 'tool_completed', 'message_completed', 'turn_completed']);
    expect(events.filter((event) => event.turn_id === 'turn-1').every((event) => event.command_id === 'cmd-1')).toBe(true);
    expect(events.find((event) => event.type === 'tool_started')?.provider_meta).toMatchObject({ item_type: 'commandExecution' });
    expect(adapter.getOutputTail(session_handle)).toContain('FAKE_CODEX_REPLY turn=turn-1');
  });

  it('handles frames split across chunks and turn/started arriving before the turn/start answer', async () => {
    process.env.FAKE_CODEX_SPLIT_FRAMES = '1';
    process.env.FAKE_CODEX_STARTED_FIRST = '1';
    process.env.FAKE_CODEX_NOISE = '1';
    const { adapter, events } = await loadAdapter();
    const { session_handle } = await startSession(adapter);

    const ack = await adapter.submit(session_handle, 'hello', { commandId: 'cmd-early' });
    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    expect(events.find((event) => event.type === 'turn_started')).toMatchObject({ turn_id: ack.turn_id, command_id: 'cmd-early' });
    expect(events.find((event) => event.type === 'turn_completed')).toMatchObject({ command_id: 'cmd-early' });
  });

  it('keeps late item events attributed without reopening a finished turn', async () => {
    process.env.FAKE_CODEX_LATE_ITEM = '1';
    const { adapter, events } = await loadAdapter();
    const { session_handle } = await startSession(adapter);

    await adapter.submit(session_handle, 'first', { commandId: 'cmd-a' });
    await waitFor(() => events.some((event) => event.provider_meta.item_type === 'fileChange'));
    const late = events.filter((event) => event.turn_id === 'turn-1');
    expect(late.at(-1)).toMatchObject({ type: 'tool_completed', command_id: 'cmd-a' });
    expect(late.findIndex((event) => event.type === 'turn_completed')).toBeLessThan(late.length - 1);

    // The late frame did not leave the session "busy": the next submission starts a new turn.
    await expect(adapter.submit(session_handle, 'second', { commandId: 'cmd-b' })).resolves.toEqual({ turn_id: 'turn-2', mode: 'started' });
  });

  it('refuses input while a turn is running instead of assuming steering', async () => {
    process.env.FAKE_CODEX_TURN_HOLD_MS = '400';
    const { adapter, events } = await loadAdapter();
    const { session_handle } = await startSession(adapter);

    await adapter.submit(session_handle, 'long task');
    await expect(adapter.submit(session_handle, 'nudge')).rejects.toMatchObject({ name: 'CapabilityRefusal', code: 'unsupported_capability', capability: 'steer' });
    await expect(adapter.send(session_handle, 'nudge')).rejects.toMatchObject({ capability: 'steer' });
    expect(frames('turn/start')).toHaveLength(1);
    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    await expect(adapter.submit(session_handle, 'after')).resolves.toMatchObject({ mode: 'started' });
  });

  it('declines provider approval requests and reports the refusal', async () => {
    process.env.FAKE_CODEX_APPROVAL = '1';
    const { adapter, events } = await loadAdapter();
    const { session_handle } = await startSession(adapter);

    await adapter.submit(session_handle, 'needs approval', { commandId: 'cmd-approve' });
    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    expect(records().find((entry) => entry.kind === 'approval_response')).toMatchObject({ result: { decision: 'decline' } });
    expect(events.filter((event) => event.type.startsWith('approval_'))).toEqual([
      expect.objectContaining({ type: 'approval_requested', provider_event: 'item/commandExecution/requestApproval', command_id: 'cmd-approve' }),
      expect.objectContaining({ type: 'approval_refused', command_id: 'cmd-approve' }),
    ]);
  });

  it('reports failed turns and provider exit, and rejects input after exit', async () => {
    process.env.FAKE_CODEX_TURN_STATUS = 'failed';
    const { adapter, events } = await loadAdapter();
    const { session_handle } = await startSession(adapter);

    await adapter.submit(session_handle, 'will fail', { commandId: 'cmd-f' });
    await waitFor(() => events.some((event) => event.type === 'turn_failed'));
    expect(events.find((event) => event.type === 'turn_failed')).toMatchObject({ command_id: 'cmd-f', provider_meta: { status: 'failed' } });

    const pid = adapter.inspectSession(session_handle).pid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => events.some((event) => event.type === 'session_exited'));
    expect(adapter.inspectSession(session_handle)).toMatchObject({ alive: false, writable: false });
    await expect(adapter.submit(session_handle, 'x')).rejects.toThrow('No live app-server session');
    await expect(adapter.heartbeatProbe(session_handle)).resolves.toBe(false);
  });

  it('does not claim sessions it did not launch', async () => {
    const { adapter } = await loadAdapter();
    expect(adapter.inspectSession('app:someone-else')).toMatchObject({ alive: false, writable: false, reason: expect.stringContaining('not attached to this process') });
    expect(adapter.ownsSession('app:someone-else')).toBe(false);
    expect(adapter.survivesCoordinatorExit()).toBe(false);
  });
});
