import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

const TOKEN = 'token-abc-123';

beforeEach(() => {
  dir = createTempStateDir('orc-report-for-duty-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/report-for-duty.ts', () => {
  it('reports for duty successfully with correct token', () => {
    const result = runCli(['--agent-id=worker-1', `--session-token=${TOKEN}`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('reported_for_duty: worker-1');
  });

  it('emits reported_for_duty event', () => {
    runCli(['--agent-id=worker-1', `--session-token=${TOKEN}`]);
    const events = readEvents();
    const event = events.find((e) => e.event === 'reported_for_duty' && e.agent_id === 'worker-1');
    expect(event).toBeDefined();
    expect((event?.payload as Record<string, unknown>)?.session_token).toBe(TOKEN);
  });

  it('updates agent session_ready_at timestamp', () => {
    runCli(['--agent-id=worker-1', `--session-token=${TOKEN}`]);
    const agents = readAgents();
    const agent = agents.find((a: Record<string, unknown>) => a.agent_id === 'worker-1');
    expect(agent?.session_ready_at).toBeTruthy();
  });

  it('exits 1 when --agent-id is missing', () => {
    const result = runCli([`--session-token=${TOKEN}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc report-for-duty');
  });

  it('exits 1 when --session-token is missing', () => {
    const result = runCli(['--agent-id=worker-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc report-for-duty');
  });

  it('exits 1 when agent is not found', () => {
    const result = runCli(['--agent-id=nonexistent', `--session-token=${TOKEN}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Agent not found');
  });

  it('exits 1 when session token does not match', () => {
    const result = runCli(['--agent-id=worker-1', '--session-token=wrong-token']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Session token mismatch');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/report-for-duty.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: 'worker-1',
      provider: 'claude',
      role: 'worker',
      status: 'idle',
      session_handle: null,
      session_token: TOKEN,
      registered_at: '2026-01-01T00:00:00Z',
    }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readAgents(): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as { agents: Array<Record<string, unknown>> }).agents;
}

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
