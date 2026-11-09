import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import type { RuntimeEvent } from './runtime.ts';

const fixtureBin = resolve(import.meta.dirname, '..', 'test-fixtures', 'bin');
const FAKE_KEYS = ['FAKE_CODEX_IGNORE_SIGTERM', 'FAKE_CODEX_NO_LIST_TURNS', 'FAKE_CODEX_ACCOUNT', 'FAKE_CODEX_SPLIT_FRAMES', 'FAKE_CODEX_STARTED_FIRST', 'FAKE_CODEX_LATE_ITEM',
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

/** The fake provider's own PID (the session PID is its exit-recording wrapper's). */
function providerPid(): number {
  return records().filter((entry) => entry.kind === 'startup').at(-1)!.pid as number;
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
  // A session whose record does not match its process (identity tests) is not stoppable through the adapter.
  for (const entry of records().filter((record) => record.kind === 'startup')) {
    try { process.kill(entry.pid as number, 'SIGKILL'); } catch { /* already gone */ }
  }
  process.env.PATH = originalPath;
  delete process.env.ORC_STATE_DIR;
  delete process.env.FAKE_CODEX_RECORD;
  for (const key of FAKE_KEYS) delete process.env[key];
  delete process.env.OPENAI_API_KEY;
  cleanupTempStateDir(dir);
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
      approvalPolicy: 'never', sandbox: 'danger-full-access', cwd: worktree,
      developerInstructions: expect.stringMatching(/^BOOTSTRAP\n\nSTRUCTURED_RUNTIME\n[\s\S]*end your turn[\s\S]*STRUCTURED_RUNTIME_END$/),
    });
    expect(events.map((event) => event.type)).toEqual(['session_ready']);
    expect(events[0].provider_meta).toMatchObject({ plan_type: 'team', resumed: false });
    expect(adapter.inspectSession(result.session_handle)).toMatchObject({ transport: 'app-server', alive: true, writable: true });
    expect(records().find((entry) => entry.kind === 'startup')?.argv).toEqual(expect.arrayContaining(['--listen', `unix://${join(dir, 'app-server', 'worker-1.sock')}`]));
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
    // The backing repo's .git subtrees, never the state dir.
    const roots = (params.config as Record<string, string[]>)['sandbox_workspace_write.writable_roots'];
    expect(roots.some((root) => root.endsWith('/.git/objects'))).toBe(true);
    expect(roots).not.toContain(dir);
    // Network access is only for a project worker's control socket.
    expect((params.config as Record<string, unknown>)['sandbox_workspace_write.network_access']).toBeUndefined();

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

  it('resumes the thread named by the session resume key, with its developer instructions, and records its exit', async () => {
    const { adapter } = await loadAdapter();
    const result = await startSession(adapter, { resume_conversation_id: 'thread-earlier', system_prompt: 'BOOT' });
    expect(frames('thread/start')).toEqual([]);
    expect(frames('thread/resume')[0].params).toMatchObject({ threadId: 'thread-earlier', developerInstructions: expect.stringContaining('BOOT') });
    expect(adapter.exitStatus(result.session_handle)).toBeNull();
    process.kill(providerPid(), 'SIGKILL');
    await waitFor(() => adapter.exitStatus(result.session_handle) != null);
    expect(adapter.exitStatus(result.session_handle)).toEqual({ code: null, signal: 'SIGKILL' });
    // The status is on disk: a process that never attached the session reads it too.
    const other = (await import('./codexAppServer.ts')).createCodexAppServerAdapter();
    expect(other.exitStatus(result.session_handle)).toEqual({ code: null, signal: 'SIGKILL' });
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

    expect(adapter.turnActive(session_handle)).toBe(false);
    await adapter.submit(session_handle, 'long task');
    expect(adapter.turnActive(session_handle)).toBe(true);
    await expect(adapter.submit(session_handle, 'nudge')).rejects.toMatchObject({ name: 'CapabilityRefusal', code: 'unsupported_capability', capability: 'steer' });
    await expect(adapter.send(session_handle, 'nudge')).rejects.toMatchObject({ capability: 'steer' });
    expect(frames('turn/start')).toHaveLength(1);
    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    expect(adapter.turnActive(session_handle)).toBe(false);
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

    process.kill(providerPid(), 'SIGKILL');
    await waitFor(() => events.some((event) => event.type === 'session_exited'));
    expect(events.find((event) => event.type === 'session_exited')?.provider_meta).toMatchObject({ code: null, signal: 'SIGKILL' });
    expect(adapter.inspectSession(session_handle)).toMatchObject({ alive: false, writable: false });
    await expect(adapter.submit(session_handle, 'x')).rejects.toThrow('No live app-server session');
    await expect(adapter.heartbeatProbe(session_handle)).resolves.toBe(false);
  });

  it('escalates to SIGKILL when the provider ignores SIGTERM', async () => {
    process.env.FAKE_CODEX_IGNORE_SIGTERM = '1';
    const { adapter } = await loadAdapter();
    const { session_handle } = await startSession(adapter);
    const pid = providerPid();
    await adapter.stop(session_handle);
    const { isPidAlive } = await import('../lib/processIdentity.ts');
    expect(records().some((entry) => entry.kind === 'sigterm_ignored')).toBe(true);
    await waitFor(() => !isPidAlive(pid), 2000);
  }, 15_000);

  it('does not claim sessions it did not launch', async () => {
    const { adapter } = await loadAdapter();
    expect(adapter.inspectSession('app:someone-else')).toMatchObject({ alive: false, writable: false, reason: expect.stringContaining('not attached to this process') });
    expect(adapter.ownsSession('app:someone-else')).toBe(false);
    expect(adapter.survivesCoordinatorExit('app:someone-else')).toBe(true);
    expect(adapter.survivesCoordinatorExit('tmux:someone-else')).toBe(false);
  });

  it('lets another process see and stop a session through its recorded process identity', async () => {
    const { adapter, events } = await loadAdapter();
    const { session_handle, provider_ref } = await startSession(adapter);
    const ref = provider_ref as { pid: number; process_start: string };
    const { initEventsDb, withEventDbTransaction } = await import('../lib/eventLog.ts');
    initEventsDb(dir);
    withEventDbTransaction(dir, (db) => {
      db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, process_pid, process_start, started_at, updated_at)
        VALUES ('s-1', NULL, 'worker-1', 'codex', 'running', 'app-server', ?, ?, '2026-01-01', '2026-01-01')`).run(ref.pid, ref.process_start);
    });

    // e.g. `orc worker-remove` or a restarted coordinator: a fresh adapter that did not launch the session.
    const other = (await import('./codexAppServer.ts')).createCodexAppServerAdapter();
    expect(other.inspectSession(session_handle)).toMatchObject({ alive: true, writable: false, pid: ref.pid, reason: expect.stringContaining('worker-remove') });
    expect(other.ownsSession(session_handle)).toBe(false);
    expect(other.turnActive(session_handle)).toBe(false);
    await other.stop(session_handle);
    await waitFor(() => events.some((event) => event.type === 'session_exited'));
    expect(other.inspectSession(session_handle)).toMatchObject({ alive: false });
  });
});

describe('codex app-server runtime: adoption after a coordinator restart', () => {
  /** Record the session as the coordinator does (lib/workerRuntime.ts), then let the launching adapter go. */
  async function launchAndDetach(adapter: Awaited<ReturnType<typeof loadAdapter>>['adapter'], { processStart, thread }: { processStart?: string; thread?: string | null } = {}) {
    const result = await startSession(adapter);
    const ref = result.provider_ref as { pid: number; process_start: string; thread_id: string };
    const { initEventsDb, withEventDbTransaction } = await import('../lib/eventLog.ts');
    initEventsDb(dir);
    withEventDbTransaction(dir, (db) => {
      db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, transport, process_pid, process_start,
        provider_conversation_id, started_at, updated_at)
        VALUES ('s-1', NULL, 'worker-1', 'codex', 'running', 'app-server', ?, ?, ?, '2026-01-01', '2026-01-01')`)
        .run(ref.pid, processStart ?? ref.process_start, thread === undefined ? ref.thread_id : thread);
    });
    return { ...result, ref };
  }

  async function restartedAdapter() {
    const next = (await import('./codexAppServer.ts')).createCodexAppServerAdapter();
    const events: RuntimeEvent[] = [];
    next.onEvent((event) => events.push(event));
    started.push({ stop: next.stop, handle: 'app:worker-1' });
    return { next, events };
  }

  it('reattaches a live app-server and its running turn, and the turn ACKs the command that started it', async () => {
    process.env.FAKE_CODEX_TURN_HOLD_MS = '600';
    const { adapter } = await loadAdapter();
    const { session_handle, ref } = await launchAndDetach(adapter);
    await adapter.submit(session_handle, 'long task', { commandId: 'cmd-long' });
    adapter.detach(session_handle);

    const { next, events } = await restartedAdapter();
    expect(next.inspectSession(session_handle)).toMatchObject({ alive: true, writable: false });
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: true, writable: true, pid: ref.pid, processStart: ref.process_start });
    expect(frames('thread/resume').at(-1)?.params).toMatchObject({ threadId: ref.thread_id, excludeTurns: true });
    expect(next.turnActive(session_handle)).toBe(true);
    expect(next.threadId(session_handle)).toBe(ref.thread_id);

    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    expect(events.find((event) => event.type === 'turn_completed')).toMatchObject({ turn_id: 'turn-1', command_id: 'cmd-long' });
    expect(next.turnActive(session_handle)).toBe(false);
    await expect(next.submit(session_handle, 'after restart', { commandId: 'cmd-next' })).resolves.toEqual({ turn_id: 'turn-2', mode: 'started' });
    // Adopting again is a no-op on an attached session.
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: true, writable: true });
    expect(frames('thread/resume')).toHaveLength(1);
  });

  it('falls back to the full thread history when the provider cannot list turns yet, and keeps the command from the turn record', async () => {
    process.env.FAKE_CODEX_TURN_HOLD_MS = '600';
    process.env.FAKE_CODEX_NO_LIST_TURNS = '1';
    const { adapter } = await loadAdapter();
    const { session_handle } = await launchAndDetach(adapter);
    await adapter.submit(session_handle, 'just started', { commandId: 'cmd-early' });
    adapter.detach(session_handle);

    const { next, events } = await restartedAdapter();
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: true, writable: true });
    expect(frames('thread/resume').slice(-2).map((frame) => (frame.params as { excludeTurns?: boolean }).excludeTurns)).toEqual([true, undefined]);
    expect(next.turnActive(session_handle)).toBe(true);
    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    expect(events.find((event) => event.type === 'turn_completed')).toMatchObject({ turn_id: 'turn-1', command_id: 'cmd-early' });
  });

  it('reports a turn that finished while no coordinator was attached', async () => {
    process.env.FAKE_CODEX_TURN_HOLD_MS = '200';
    const { adapter } = await loadAdapter();
    const { session_handle } = await launchAndDetach(adapter);
    await adapter.submit(session_handle, 'work', { commandId: 'cmd-offline' });
    adapter.detach(session_handle);
    // The turn ends with no client attached; only the provider knows.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const { next, events } = await restartedAdapter();
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: true, writable: true });
    expect(events.filter((event) => event.type === 'turn_completed')).toEqual([expect.objectContaining({ turn_id: 'turn-1', command_id: 'cmd-offline' })]);
    expect(next.turnActive(session_handle)).toBe(false);

    // Reported once: a further restart does not report it again.
    next.detach(session_handle);
    const again = await restartedAdapter();
    await again.next.adoptSession(session_handle);
    expect(again.events.filter((event) => event.type.startsWith('turn_'))).toEqual([]);
  });

  it('does not report again a turn the previous coordinator already saw finish', async () => {
    const { adapter, events } = await loadAdapter();
    const { session_handle } = await launchAndDetach(adapter);
    await adapter.submit(session_handle, 'work', { commandId: 'cmd-seen' });
    await waitFor(() => events.some((event) => event.type === 'turn_completed'));
    adapter.detach(session_handle);

    const { next, events: adopted } = await restartedAdapter();
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: true, writable: true });
    expect(adopted.filter((event) => event.type.startsWith('turn_'))).toEqual([]);
    expect(next.turnActive(session_handle)).toBe(false);
  });

  it('does not adopt an app-server that exited, and says why', async () => {
    const { adapter } = await loadAdapter();
    const { session_handle } = await launchAndDetach(adapter);
    adapter.detach(session_handle);
    process.kill(providerPid(), 'SIGKILL');
    await waitFor(() => adapter.exitStatus(session_handle) != null);

    const { next } = await restartedAdapter();
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: false, writable: false, reason: 'app-server exited (signal SIGKILL) while no coordinator was attached' });
    expect(next.exitStatus(session_handle)).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('does not adopt a process whose identity does not match the record', async () => {
    const { adapter } = await loadAdapter();
    const { session_handle } = await launchAndDetach(adapter, { processStart: 'proc:not-this-one' });
    adapter.detach(session_handle);

    const { next } = await restartedAdapter();
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: false, reason: expect.stringContaining('now belongs to another process') });
    expect(frames('initialize')).toHaveLength(1);
  });

  it('stops a live app-server it cannot reattach, so it does not work unsupervised', async () => {
    const { adapter } = await loadAdapter();
    const { session_handle, ref } = await launchAndDetach(adapter, { thread: null });
    adapter.detach(session_handle);

    const { next } = await restartedAdapter();
    await expect(next.adoptSession(session_handle)).resolves.toMatchObject({ alive: false, reason: 'no recorded provider thread to reattach; stopped the app-server' });
    const { isPidAlive } = await import('../lib/processIdentity.ts');
    expect(isPidAlive(ref.pid)).toBe(false);
  });
});
