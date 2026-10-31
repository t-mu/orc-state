import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { ControlClient } from './controlClient.ts';
import { parseStopHookInput, stopHookOutput } from './stopHook.ts';

const repoRoot = join(import.meta.dirname, '..');

describe('parseStopHookInput', () => {
  it('reads stop_hook_active and treats anything unreadable as a first stop', () => {
    expect(parseStopHookInput('{"stop_hook_active":true,"session_id":"s"}')).toEqual({ stopHookActive: true });
    expect(parseStopHookInput('{"stop_hook_active":"yes"}')).toEqual({ stopHookActive: false });
    expect(parseStopHookInput('null')).toEqual({ stopHookActive: false });
    expect(parseStopHookInput('not json')).toEqual({ stopHookActive: false });
  });
});

describe('stopHookOutput', () => {
  it('prints a block decision with the coordinator\'s reason', async () => {
    const seen: boolean[] = [];
    const output = await stopHookOutput('{"stop_hook_active":true}', (active) => {
      seen.push(active);
      return Promise.resolve({ allow: false, reason: 'Run run-a (phase implement) is not finished.' });
    });
    expect(seen).toEqual([true]);
    expect(JSON.parse(output!)).toEqual({ decision: 'block', reason: 'Run run-a (phase implement) is not finished.' });
  });

  it('prints nothing when the coordinator allows the stop or there is no session', async () => {
    expect(await stopHookOutput('{}', () => Promise.resolve({ allow: true }))).toBeNull();
    expect(await stopHookOutput('{}', null)).toBeNull();
  });

  it('fails open when the check throws', async () => {
    expect(await stopHookOutput('{}', () => Promise.reject(new Error('boom')))).toBeNull();
  });

  describe('without a reachable coordinator', () => {
    let dir: string;
    beforeEach(() => { dir = createTempStateDir('orch-stop-hook-'); });
    afterEach(() => { cleanupTempStateDir(dir); });

    it('fails open when the control socket is unavailable', async () => {
      const client = new ControlClient(dir, { credential: 'session-a', timeoutMs: 1000 });
      await expect(client.stopCheck(false)).rejects.toMatchObject({ code: 'unavailable' });
      expect(await stopHookOutput('{"stop_hook_active":false}', (active) => client.stopCheck(active))).toBeNull();
    });

    it('`orc stop-check` exits 0 with no output when the control socket is unavailable', () => {
      const result = spawnSync(process.execPath, [join(repoRoot, 'cli', 'stop-check.ts')], {
        cwd: repoRoot, encoding: 'utf8', input: '{"stop_hook_active":false}', timeout: 20_000,
        env: { ...process.env, ORC_STATE_DIR: dir, ORC_SESSION_SECRET: 'session-a', ORC_MASTER_SECRET: '',
          ORC_CONTROL_SOCKET: join(dir, 'missing.sock') },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });
  });
});
