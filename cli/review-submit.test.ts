import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-review-submit-test-');
  // Minimal state dir — review-submit does not require claims or agents
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function runCli(args: string[] = []) {
  return spawnSync('node', ['cli/review-submit.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function readEvents(): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}

describe('orc review-submit', () => {
  it('writes review_submitted event to SQLite on success', () => {
    const result = runCli([
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=approved',
      '--reason=LGTM',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('review_submitted');

    const events = readEvents();
    expect(events.some((e) => e.event === 'review_submitted' && e.run_id === 'run-abc')).toBe(true);
  });

  it('stores outcome=approved with findings text in payload', () => {
    runCli([
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=approved',
      '--reason=LGTM',
    ]);

    const events = readEvents();
    const ev = events.find((e) => e.event === 'review_submitted');
    expect(ev).toBeDefined();
    expect((ev!.payload as Record<string, unknown>).outcome).toBe('approved');
    expect((ev!.payload as Record<string, unknown>).findings).toBe('LGTM');
  });

  it('stores outcome=findings with full findings text', () => {
    runCli([
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=findings',
      '--reason=Line 42: missing null check',
    ]);

    const events = readEvents();
    const ev = events.find((e) => e.event === 'review_submitted');
    expect(ev).toBeDefined();
    expect((ev!.payload as Record<string, unknown>).outcome).toBe('findings');
    expect((ev!.payload as Record<string, unknown>).findings).toBe('Line 42: missing null check');
  });

  it('exits 1 when --outcome is not approved or findings', () => {
    const result = runCli([
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=invalid',
      '--reason=some text',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'approved' or 'findings'");
  });

  it('exits 1 when --reason is absent', () => {
    const result = runCli([
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=approved',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--reason');
  });

  it('exits 1 when --run-id is missing', () => {
    const result = runCli([
      '--agent-id=reviewer-1',
      '--outcome=approved',
      '--reason=LGTM',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('exits 1 when --agent-id is missing', () => {
    const result = runCli([
      '--run-id=run-abc',
      '--outcome=approved',
      '--reason=LGTM',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('stores two events when called twice with same agent-id (no dedup at write)', () => {
    const args = [
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=approved',
      '--reason=LGTM',
    ];

    const r1 = runCli(args);
    const r2 = runCli(args);

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);

    const events = readEvents().filter((e) => e.event === 'review_submitted' && e.run_id === 'run-abc');
    expect(events).toHaveLength(2);
  });
});
