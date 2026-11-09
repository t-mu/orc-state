import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAllDatabases, initEventsDb } from './eventLog.ts';
import { deletePendingSessionStart, listPendingSessionStarts, savePendingSessionStart } from './pendingSessionStarts.ts';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-pending-starts-');
  initEventsDb(dir);
});

afterEach(() => {
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('pending session starts', () => {
  it('keeps one record per agent, the latest replacing the older, until deleted', () => {
    savePendingSessionStart(dir, 'worker-1', { type: 'session_start', session_id: 'conv-1', source: 'startup', orc_session_id: 's-1', ts: '2026-11-09T10:00:00.000Z' }, '2026-11-09T10:00:01.000Z');
    savePendingSessionStart(dir, 'scout-1', { type: 'session_start', session_id: '', source: '', ts: '2026-11-09T10:00:02.000Z' }, '2026-11-09T10:00:02.000Z');
    savePendingSessionStart(dir, 'worker-1', { type: 'session_start', session_id: 'conv-2', source: 'clear', orc_session_id: 's-2', ts: '2026-11-09T10:00:03.000Z' }, '2026-11-09T10:00:04.000Z');

    expect(listPendingSessionStarts(dir)).toEqual([
      { agentId: 'scout-1', receivedAt: '2026-11-09T10:00:02.000Z', record: { type: 'session_start', session_id: '', source: '', ts: '2026-11-09T10:00:02.000Z' } },
      {
        agentId: 'worker-1', receivedAt: '2026-11-09T10:00:04.000Z',
        record: { type: 'session_start', session_id: 'conv-2', source: 'clear', orc_session_id: 's-2', ts: '2026-11-09T10:00:03.000Z' },
      },
    ]);

    deletePendingSessionStart(dir, 'worker-1');
    deletePendingSessionStart(dir, 'missing');
    expect(listPendingSessionStarts(dir).map((pending) => pending.agentId)).toEqual(['scout-1']);
  });
});
