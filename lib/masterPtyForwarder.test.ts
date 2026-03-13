import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendNotification, readPendingNotifications } from './masterNotifyQueue.ts';
import { startMasterPtyForwarder } from './masterPtyForwarder.ts';

function makePtyEmitter() {
  let callback: ((chunk: string) => void) | null = null;
  let disposed = false;
  return {
    emit(chunk: string) {
      callback?.(chunk);
    },
    onData(cb: (chunk: string) => void) {
      callback = cb;
      return {
        dispose() {
          disposed = true;
          callback = null;
        },
      };
    },
    isDisposed() {
      return disposed;
    },
  };
}

describe('startMasterPtyForwarder', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-master-fwd-test-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T07:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not inject before any idle prompt is observed', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    vi.advanceTimersByTime(20_000);
    stop();

    expect(writes).toHaveLength(0);
  });

  it('injects after prompt is observed and stdin stays silent', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-b',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('\u001b[0m> ');
    vi.advanceTimersByTime(5_000);
    stop();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[ORCHESTRATOR] TASK_COMPLETE');
    expect(writes[0]).toContain('orch/task-b');
    expect(writes[0]).toContain('orc-1');
    expect(writes[0]).toContain('✓ success');
    expect(readPendingNotifications(dir)).toHaveLength(0);
  });

  it('does not inject when stdin occurs after prompt', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-c',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('> ');
    process.stdin.emit('data', Buffer.from('x'));
    vi.advanceTimersByTime(5_000);
    stop();

    expect(writes).toHaveLength(0);
    expect(readPendingNotifications(dir)).toHaveLength(1);
  });

  it('does not inject when prompt is stale', () => {
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('> ');
    vi.advanceTimersByTime(61_000);
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-d',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    vi.advanceTimersByTime(5_000);
    stop();

    expect(writes).toHaveLength(0);
  });

  it('resets prompt gate after a successful injection', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-e1',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);

    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-e2',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:01.000Z',
    });
    vi.advanceTimersByTime(5_000); // deferred '\r' from tick 1 fires during this advance
    stop();

    // Two writes: payload from tick 1 + deferred submit keystroke.
    // Task e2 stays pending because no new prompt was observed after gate reset.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('orch/task-e1');
    expect(writes[1]).toBe('\r');
    expect(readPendingNotifications(dir)).toHaveLength(1);
  });

  it('swallows master PTY write errors during polling', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-f',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const fakePty = {
      write: () => {
        throw new Error('pty gone');
      },
    };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('> ');
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    stop();
  });

  it('stop disposes pty data subscription and clears timer', () => {
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    stop();

    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-g',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    emitter.emit('> ');
    vi.advanceTimersByTime(10_000);

    expect(emitter.isDisposed()).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it('formats failed task notifications with failed result marker', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-h',
      agent_id: 'orc-2',
      success: false,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);
    stop();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('✗ failed');
  });

  it('formats input requests for master follow-up', () => {
    appendNotification(dir, {
      type: 'INPUT_REQUEST',
      task_ref: 'orch/task-input',
      run_id: 'run-input-1',
      agent_id: 'orc-2',
      question: 'Should I answer yes?',
      requested_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);
    stop();

    expect(writes[0]).toContain('[ORCHESTRATOR] INPUT_REQUEST');
    expect(writes[0]).toContain('respond_input(run_id, agent_id, response)');
    expect(writes[0]).toContain('Should I answer yes?');
  });

  it('wraps payload with bracketed paste markers when bracketed paste is enabled', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-bp-enabled',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('\x1b[?2004h');
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);   // fires payload write
    vi.advanceTimersByTime(250);     // flushes the deferred submit keystroke (200 ms delay)
    stop();

    // Payload arrives first, then deferred '\r' submit.
    expect(writes).toHaveLength(2);
    expect(writes[0].startsWith('\x1b[200~')).toBe(true);
    expect(writes[0]).toContain('\x1b[201~');
    expect(writes[1]).toBe('\r');
  });

  it('sends raw payload without bracketed paste markers when bracketed paste is disabled', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-bp-disabled',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();

    const stop = startMasterPtyForwarder(dir, fakePty, emitter);
    emitter.emit('\x1b[?2004l');
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);   // fires payload write
    vi.advanceTimersByTime(250);     // flushes the deferred submit keystroke (200 ms delay)
    stop();

    // Payload arrives first (no bracketed paste), then deferred '\r' submit.
    expect(writes).toHaveLength(2);
    expect(writes[0]).not.toContain('\x1b[200~');
    expect(writes[0]).not.toContain('\x1b[201~');
    expect(writes[1]).toBe('\r');
  });

  it('toggles bracketed paste state across on/off/on transitions', () => {
    const writes: string[] = [];
    const fakePty = { write: (content: string) => writes.push(content) };
    const emitter = makePtyEmitter();
    const stop = startMasterPtyForwarder(dir, fakePty, emitter);

    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-toggle-1',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    emitter.emit('\x1b[?2004h');
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);

    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-toggle-2',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:01.000Z',
    });
    emitter.emit('\x1b[?2004l');
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);

    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-toggle-3',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:02.000Z',
    });
    emitter.emit('\x1b[?2004h');
    emitter.emit('> ');
    vi.advanceTimersByTime(5_000);
    stop();

    // With deferred submit: each tick produces (payload, then '\r' fires during next advance).
    // Sequence: payload1, '\r' (from tick1, fires during tick2), payload2, '\r' (from tick2), payload3.
    expect(writes).toHaveLength(5);
    expect(writes[0]).toContain('\x1b[200~');   // payload1 — bracketed paste ON
    expect(writes[1]).toBe('\r');                // deferred submit from tick 1
    expect(writes[2]).not.toContain('\x1b[200~'); // payload2 — bracketed paste OFF
    expect(writes[3]).toBe('\r');                // deferred submit from tick 2
    expect(writes[4]).toContain('\x1b[200~');   // payload3 — bracketed paste ON again
  });

});
