import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let stateDir: string;

beforeEach(() => {
  stateDir = createTempStateDir('orc-attach-int-');
});

afterEach(() => {
  cleanupTempStateDir(stateDir);
});

function runAttach(handle: string) {
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: 'worker-01', provider: 'claude', role: 'worker', status: 'running',
      session_handle: handle, registered_at: '2026-01-01T00:00:00.000Z', last_heartbeat_at: null,
    }],
  }));
  // Piped stdio: the child has no TTY, as from a script or a worker's Bash tool.
  return spawnSync(process.execPath, ['cli/attach.ts', 'worker-01'], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
}

describe('cli/attach.ts integration', () => {
  it('exits 1 without a TTY and suggests orc terminal --once', () => {
    const result = runAttach('tmux:worker-01');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('needs an interactive terminal');
    expect(result.stderr).toContain('--once');
    expect(result.stderr).not.toContain('Log file:');
  });

  it('exits 1 for a pty session and points at orc terminal', () => {
    const result = runAttach('pty:worker-01');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('orc terminal provider');
    expect(result.stderr).not.toContain('Log file:');
  });
});
