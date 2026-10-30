import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, findTask, readAgents, readClaims } from './stateReader.ts';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-state-reader-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('readJson', () => {
  it('reads and parses a json file', () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
    expect(readJson(dir, 'agents.json')).toEqual({ version: '1', agents: [] });
  });

  it('reads backlog.json from the project task store, not the projection file', () => {
    seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1' }]);
    rmSync(join(dir, 'backlog.json'));
    const backlog = readJson(dir, 'backlog.json') as { features: Array<{ ref: string; tasks: Array<{ ref: string; status: string }> }> };
    expect(backlog.features.map((feature) => feature.ref)).toEqual(['docs']);
    expect(backlog.features[0].tasks).toMatchObject([{ ref: 'docs/task-1', status: 'todo' }]);
  });
});

describe('findTask', () => {
  it('finds a task by ref across features', () => {
    const backlog = {
      version: '1',
      features: [
        { ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }] },
        { ref: 'engine', title: 'Engine', tasks: [{ ref: 'engine/task-2', title: 'Task 2', status: 'todo' }] },
      ],
    };
    expect(findTask(backlog, 'engine/task-2')?.title).toBe('Task 2');
  });

  it('returns null when missing', () => {
    expect(findTask({ version: '1', features: [] }, 'docs/task-x')).toBeNull();
  });
});

describe('readAgents', () => {
  it('returns parsed agents file when present', () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [{ agent_id: 'bob' }] }));
    expect(readAgents(dir).agents).toHaveLength(1);
  });

  it('returns empty default when missing', () => {
    expect(readAgents(dir)).toEqual({ version: '1', agents: [] });
  });

  it('logs to stderr and returns empty default on non-ENOENT error', () => {
    writeFileSync(join(dir, 'agents.json'), 'NOT VALID JSON');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = readAgents(dir);
      expect(result).toEqual({ version: '1', agents: [] });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('[stateReader]'),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('readClaims', () => {
  it('imports a migrated claims.json into the run store once and reads the store after', () => {
    const claim = { run_id: 'run-1', task_ref: 'orch/task-1', agent_id: 'worker-1', state: 'done', claimed_at: '2026-01-01T00:00:00Z', lease_expires_at: '2026-01-01T01:00:00Z' };
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [claim] }));
    expect(readClaims(dir).claims.map((entry) => entry.run_id)).toEqual(['run-1']);
    // The file is a projection from now on: editing it changes nothing.
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
    expect(readClaims(dir).claims.map((entry) => entry.run_id)).toEqual(['run-1']);
  });

  it('returns empty default when missing', () => {
    expect(readClaims(dir)).toEqual({ version: '1', claims: [] });
  });

  it('logs to stderr and returns empty default on non-ENOENT error', () => {
    writeFileSync(join(dir, 'claims.json'), 'NOT VALID JSON');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = readClaims(dir);
      expect(result).toEqual({ version: '1', claims: [] });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('[stateReader]'),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
