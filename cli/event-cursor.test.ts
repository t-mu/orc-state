import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb } from '../lib/eventLog.ts';
import { advanceEventOffset, initializeEventOffset } from '../lib/eventOffsets.ts';

let dir: string;
beforeEach(() => { dir = createTempStateDir('orch-cursor-cli-'); seedState(dir); initEventsDb(dir); });
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

function run(...args: string[]) {
  return spawnSync(process.execPath, ['cli/event-cursor.ts', ...args], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, ORC_STATE_DIR: dir, ORC_REPO_ROOT: dir },
    encoding: 'utf8',
  });
}

describe('event-cursor recovery CLI', () => {
  it('shows, resets and reads a named cursor', () => {
    expect(JSON.parse(run('--consumer=coordinator').stdout)).toEqual({ consumer_id: 'coordinator', last_event_seq: 0 });
    initializeEventOffset(dir);
    advanceEventOffset(dir, 0, 12);
    expect(JSON.parse(run('--consumer=coordinator', '--reset-to=6').stdout)).toEqual({ consumer_id: 'coordinator', last_event_seq: 6 });
    expect(JSON.parse(run('--consumer=coordinator').stdout).last_event_seq).toBe(6);
    expect(run('--reset-to=13').status).toBe(1);
  });

  it('rejects invalid offsets and a reset while the coordinator is alive', () => {
    expect(run('--reset-to=-1').status).toBe(1);
    writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const result = run('--reset-to=1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stop the coordinator');
  });
});
