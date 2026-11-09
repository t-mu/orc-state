import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from '../lib/eventLog.ts';

let dir: string;
beforeEach(() => {
  dir = createTempStateDir('orch-sessions-cli-');
  seedState(dir);
  initEventsDb(dir);
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at, transport, process_pid, state_reason)
      VALUES ('s-live', NULL, 'worker-a', 'claude', 'recoverable', 'now', 'now', 'pty', 42, 'stop it with orc worker-remove'),
        ('s-old', NULL, 'worker-b', 'claude', 'offline', 'now', 'now', 'tmux', 43, NULL)`).run();
  });
});
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

function run(...args: string[]) {
  return spawnSync(process.execPath, ['cli/sessions.ts', ...args], {
    cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, ORC_STATE_DIR: dir },
  });
}

describe('orc sessions', () => {
  it('lists live sessions with their recovery reason and hides offline ones by default', () => {
    const text = run().stdout;
    expect(text).toContain('s-live worker-a state=recoverable transport=pty pid=42');
    expect(text).toContain('reason: stop it with orc worker-remove');
    expect(text).not.toContain('s-old');
    const all = JSON.parse(run('--all', '--json').stdout) as { total: number; sessions: Array<{ session_id: string; capabilities: Record<string, unknown> }> };
    expect(all.total).toBe(2);
    // A legacy pty session can do nothing; a Claude tmux session resumes and attaches.
    expect(all.sessions.find((s) => s.session_id === 's-live')?.capabilities).toMatchObject({ resume: false, attach: false });
    expect(all.sessions.find((s) => s.session_id === 's-old')?.capabilities).toMatchObject({ resume: true, attach: true, conversation_id: 'orc' });
  });
});
