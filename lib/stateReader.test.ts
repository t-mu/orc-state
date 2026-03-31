import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, findTask, readAgents, readClaims, getNextTaskSeq } from './stateReader.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-state-reader-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readJson', () => {
  it('reads and parses a json file', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
    expect(readJson(dir, 'backlog.json')).toEqual({ version: '1', features: [] });
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
  it('returns parsed claims file when present', () => {
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [{ run_id: 'run-1' }] }));
    expect(readClaims(dir).claims).toHaveLength(1);
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

describe('getNextTaskSeq', () => {
  it('returns backlog.next_task_seq when present', () => {
    expect(getNextTaskSeq({ version: '1', next_task_seq: 12, features: [] })).toBe(12);
  });

  it('bootstraps from numbered task refs when field is absent', () => {
    const backlog = {
      version: '1',
      features: [
        {
          ref: 'orch',
          title: 'Orchestrator',
          tasks: [
            { ref: 'orch/task-7-old', title: 'Task 7', status: 'done' },
            { ref: 'orch/task-124-backlog-next-task-seq', title: 'Task 124', status: 'todo' },
          ],
        },
      ],
    };

    expect(getNextTaskSeq(backlog)).toBe(125);
  });

  it('returns 1 when no numbered refs exist and field is absent', () => {
    const backlog = {
      version: '1',
      features: [
        {
          ref: 'orch',
          title: 'Orchestrator',
          tasks: [{ ref: 'orch/add-health-check', title: 'Task', status: 'todo' }],
        },
      ],
    };

    expect(getNextTaskSeq(backlog)).toBe(1);
  });
});
