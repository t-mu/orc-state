import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-init-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[] = []) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/init.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: join(dir, 'state') },
    encoding: 'utf8',
  });
}

describe('cli/init.ts', () => {
  it('creates all four state files', () => {
    const result = run();
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    expect(existsSync(join(stateDir, 'backlog.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.jsonl'))).toBe(true);
  });

  it('creates default epic when not provided', () => {
    const result = run();
    expect(result.status).toBe(0);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.epics).toHaveLength(1);
    expect(backlog.epics[0].ref).toBe('project');
  });

  it('creates custom epic ref and title', () => {
    const result = run(['--epic=my-app', '--epic-title=My App']);
    expect(result.status).toBe(0);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.epics[0].ref).toBe('my-app');
    expect(backlog.epics[0].title).toBe('My App');
  });

  it('fails without --force when files already exist', () => {
    expect(run().status).toBe(0);
    const second = run();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already contains');
  });

  it('backs up files and overwrites when --force is used', () => {
    expect(run().status).toBe(0);
    writeFileSync(join(dir, 'state', 'events.jsonl'), '{"seq":1}\n');

    const result = run(['--force']);
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    expect(existsSync(join(stateDir, 'backlog.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.jsonl.bak'))).toBe(true);
  });
});
