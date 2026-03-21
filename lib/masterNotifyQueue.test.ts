import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendNotification,
  readPendingNotifications,
  markConsumed,
  readAndMarkConsumed,
  compactQueue,
} from './masterNotifyQueue.ts';

let dir: string;
let queuePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-master-notify-test-'));
  queuePath = join(dir, 'master-notify-queue.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendNotification', () => {
  it('writes JSONL entries with increasing seq and consumed=false', () => {
    const firstResult = appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    const secondResult = appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-b',
      agent_id: 'orc-1',
      success: false,
      finished_at: '2026-03-08T07:01:00.000Z',
    });

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);

    const lines = readFileSync(queuePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.consumed).toBe(false);
    expect(second.consumed).toBe(false);
  });

  it('returns false when append cannot acquire lock path/write target', () => {
    const result = appendNotification('/nonexistent/path', {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-x',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    expect(result).toBe(false);
  });

  it('does not throw when file contains malformed JSON lines', () => {
    writeFileSync(queuePath, '{"seq":1}\nnot-json\n', 'utf8');
    expect(() => appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-c',
      agent_id: 'orc-2',
      success: true,
      finished_at: '2026-03-08T07:02:00.000Z',
    })).not.toThrow();
  });

  it('keeps seq values unique across multiple appends', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-b',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:01:00.000Z',
    });

    const pending = readPendingNotifications(dir);
    const seqs = pending.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('drops duplicate notifications with the same dedupe_key', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      dedupe_key: 'task-complete:run-1:finished',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      dedupe_key: 'task-complete:run-1:finished',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });

    const pending = readPendingNotifications(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0].dedupe_key).toBe('task-complete:run-1:finished');
  });

  it('appendNotification with type FINALIZE_BLOCKED is idempotent via dedupe_key', () => {
    appendNotification(dir, {
      type: 'FINALIZE_BLOCKED',
      run_id: 'run-abc',
      dedupe_key: 'finalize_blocked:run-abc',
    });
    appendNotification(dir, {
      type: 'FINALIZE_BLOCKED',
      run_id: 'run-abc',
      dedupe_key: 'finalize_blocked:run-abc',
    });
    const pending = readPendingNotifications(dir);
    expect(pending.filter(e => e.type === 'FINALIZE_BLOCKED')).toHaveLength(1);
  });

  it('still appends distinct notifications when dedupe_key differs or is absent', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      dedupe_key: 'task-complete:run-1:finished',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      dedupe_key: 'task-complete:run-1:failed',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: false,
      finished_at: '2026-03-08T07:00:01.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-b',
      agent_id: 'orc-2',
      success: true,
      finished_at: '2026-03-08T07:00:02.000Z',
    });

    const pending = readPendingNotifications(dir);
    expect(pending).toHaveLength(3);
  });
});

describe('readPendingNotifications and markConsumed', () => {
  it('returns only unconsumed notifications and marks selected seqs as consumed', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-b',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:01:00.000Z',
    });

    const before = readPendingNotifications(dir);
    expect(before.map((entry) => entry.seq)).toEqual([1, 2]);

    markConsumed(dir, [1]);

    const after = readPendingNotifications(dir);
    expect(after.map((entry) => entry.seq)).toEqual([2]);
  });

  it('full consume-mark cycle returns empty pending notifications', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-b',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:01:00.000Z',
    });

    const pending = readPendingNotifications(dir);
    expect(pending).toHaveLength(2);

    markConsumed(dir, pending.map((entry) => entry.seq));

    expect(readPendingNotifications(dir)).toHaveLength(0);
  });

  it('does not mark notifications when seq does not match any entry', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-a',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-b',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:01:00.000Z',
    });

    markConsumed(dir, [999]);

    expect(readPendingNotifications(dir)).toHaveLength(2);
  });
});

describe('readAndMarkConsumed', () => {
  it('returns pending notifications and marks them consumed in one operation', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-r1',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-r2',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:01:00.000Z',
    });

    const consumedNow = readAndMarkConsumed(dir);

    expect(consumedNow.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(readPendingNotifications(dir)).toHaveLength(0);
  });

  it('returns empty array when queue file is missing', () => {
    expect(readAndMarkConsumed(dir)).toEqual([]);
  });
});

describe('compactQueue', () => {
  it('removes consumed entries and keeps unconsumed entries', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-c1',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:00:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-c2',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:01:00.000Z',
    });
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-c3',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:02:00.000Z',
    });
    markConsumed(dir, [1, 3]);

    compactQueue(dir);

    const lines = readFileSync(queuePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).seq).toBe(2);
  });

  it('is a no-op when nothing is consumed', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE',
      task_ref: 'orch/task-c4',
      agent_id: 'orc-1',
      success: true,
      finished_at: '2026-03-08T07:03:00.000Z',
    });
    const before = readFileSync(queuePath, 'utf8');

    compactQueue(dir);

    const after = readFileSync(queuePath, 'utf8');
    expect(after).toBe(before);
  });

  it('completes gracefully when queue file is missing', () => {
    expect(() => compactQueue(dir)).not.toThrow();
  });
});
