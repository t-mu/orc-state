import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { queryEvents } from '../lib/eventLog.ts';
import { runWorkerCli } from '../test-fixtures/projectCli.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-review-submit-test-');
  // Minimal state dir — review-submit does not require claims or agents
  seedProjectTasks(dir, []);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function runCli(args: string[] = []) {
  return runWorkerCli(dir, 'review-submit.ts', args);
}

function readEvents(): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}

describe('orc review-submit', () => {
  it('writes review_submitted event to SQLite on success', async () => {
    const result = await runCli([
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

  it('stores outcome=approved with findings text in payload', async () => {
    await runCli([
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

  it('stores the optional --reviewer label in the payload', async () => {
    await runCli(['--run-id=run-abc', '--agent-id=broken-nose', '--reviewer=critic', '--outcome=approved', '--reason=LGTM']);
    const ev = readEvents().find((e) => e.event === 'review_submitted');
    expect((ev!.payload as Record<string, unknown>).reviewer).toBe('critic');
  });

  it('stores outcome=findings with full findings text', async () => {
    await runCli([
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

  it('exits 1 when --outcome is not approved or findings', async () => {
    const result = await runCli([
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=invalid',
      '--reason=some text',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'approved' or 'findings'");
  });

  it('exits 1 when --reason is absent', async () => {
    const result = await runCli([
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=approved',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--reason');
  });

  it('exits 1 when --run-id is missing', async () => {
    const result = await runCli([
      '--agent-id=reviewer-1',
      '--outcome=approved',
      '--reason=LGTM',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('exits 1 when --agent-id is missing', async () => {
    const result = await runCli([
      '--run-id=run-abc',
      '--outcome=approved',
      '--reason=LGTM',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });

  it('stores two events when called twice with same agent-id (no dedup at write)', async () => {
    const args = [
      '--run-id=run-abc',
      '--agent-id=reviewer-1',
      '--outcome=approved',
      '--reason=LGTM',
    ];

    const r1 = await runCli(args);
    const r2 = await runCli(args);

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);

    const events = readEvents().filter((e) => e.event === 'review_submitted' && e.run_id === 'run-abc');
    expect(events).toHaveLength(2);
  });
});
