import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { appendSequencedEvent } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-review-read-test-');
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function runCli(args: string[] = []) {
  return spawnSync('node', ['cli/review-read.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function submitReview(runId: string, agentId: string, outcome: 'approved' | 'findings', findings: string) {
  appendSequencedEvent(dir, {
    ts: new Date().toISOString(),
    event: 'review_submitted',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    agent_id: agentId,
    payload: { outcome, findings },
  });
}

describe('orc review-read', () => {
  it('returns all reviews for a run_id', () => {
    submitReview('run-abc', 'reviewer-1', 'approved', 'LGTM');
    submitReview('run-abc', 'reviewer-2', 'findings', 'Missing null check');

    const result = runCli(['--run-id=run-abc']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('reviewer-1');
    expect(result.stdout).toContain('reviewer-2');
    expect(result.stdout).toContain('LGTM');
    expect(result.stdout).toContain('Missing null check');
  });

  it('deduplicates by agent_id — keeps latest when same agent submits twice', () => {
    submitReview('run-abc', 'reviewer-1', 'findings', 'First submission');
    submitReview('run-abc', 'reviewer-1', 'approved', 'Second submission LGTM');

    const result = runCli(['--run-id=run-abc']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Second submission LGTM');
    expect(result.stdout).not.toContain('First submission');
    // Should only appear once
    expect(result.stdout.split('reviewer-1').length - 1).toBe(1);
  });

  it('returns empty result and exits 0 when no reviews exist', () => {
    const result = runCli(['--run-id=run-abc']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No reviews found for run run-abc');
  });

  it('returns partial result and exits 0 when only 1 of 2 reviewers submitted', () => {
    submitReview('run-abc', 'reviewer-1', 'approved', 'LGTM');

    const result = runCli(['--run-id=run-abc']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('reviewer-1');
    expect(result.stdout).toContain('LGTM');
  });

  it('--json outputs valid JSON with count and reviews array', () => {
    submitReview('run-abc', 'reviewer-1', 'approved', 'LGTM');
    submitReview('run-abc', 'reviewer-2', 'findings', 'Some issue');

    const result = runCli(['--run-id=run-abc', '--json']);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as { count: number; reviews: unknown[] };
    expect(parsed.count).toBe(2);
    expect(Array.isArray(parsed.reviews)).toBe(true);
    expect(parsed.reviews).toHaveLength(2);
  });

  it('--json outputs count 0 and empty array when no reviews', () => {
    const result = runCli(['--run-id=run-abc', '--json']);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as { count: number; reviews: unknown[] };
    expect(parsed.count).toBe(0);
    expect(parsed.reviews).toHaveLength(0);
  });

  it('exits 1 when --run-id is missing', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--run-id is required');
  });

  it('does not return reviews from a different run_id', () => {
    submitReview('run-other', 'reviewer-1', 'approved', 'LGTM for other run');

    const result = runCli(['--run-id=run-abc']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No reviews found for run run-abc');
    expect(result.stdout).not.toContain('LGTM for other run');
  });
});
