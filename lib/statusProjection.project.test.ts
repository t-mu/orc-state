import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { claimTask } from './claimManager.ts';
import { closeAllDatabases, initEventsDb } from './eventLog.ts';
import { closeProjectTaskStores, createProjectTask, initProjectTaskStore, reviseProjectTask } from './projectTasks.ts';
import { readControlSnapshot } from './statusProjection.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-snapshot-');
  initEventsDb(dir);
});

afterEach(() => {
  closeProjectTaskStores();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('control snapshot project fields', () => {
  it('carries no project or task fields for a legacy state directory', () => {
    // No task store: a legacy layout's run is only its claim.
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [{
      run_id: 'run-a', task_ref: 'orch/a', agent_id: 'worker-a', state: 'claimed',
      claimed_at: '2026-01-01T00:00:00.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z',
    }] }));
    const snapshot = readControlSnapshot(dir);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.project).toBeNull();
    expect(snapshot.runs[0]).not.toHaveProperty('task_status');
    expect(snapshot.runs[0]).not.toHaveProperty('spec_revision');
  });

  it('reports the project and each run\'s SQLite task status and pinned revision', () => {
    seedState(dir);
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'p1', name: 'product', target_repo_root: '/repo' }));
    initProjectTaskStore(dir);
    createProjectTask(dir, { feature: 'app', ref: 'snap', body_markdown: '# Snap\n' });
    const { run_id } = claimTask(dir, 'app/snap', 'worker-a');
    reviseProjectTask(dir, 'app/snap', 1, { body_markdown: '# Snap\n\nLater edit.\n' });
    const snapshot = readControlSnapshot(dir);
    expect(snapshot.project).toEqual({ id: 'p1', name: 'product', target_repo_root: '/repo' });
    expect(snapshot.runs).toEqual([expect.objectContaining({ run_id, task_status: 'claimed', spec_revision: 1 })]);
  });
});
