import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import {
  validateBacklog,
  validateAgents,
  validateClaims,
  validateRunWorktrees,
  validateStateDir,
} from './stateValidation.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_BACKLOG = { version: '1', features: [] };
const VALID_AGENTS = { version: '1', agents: [] };
const VALID_CLAIMS = { version: '1', claims: [] };
const VALID_RUN_WORKTREES = { version: '1', runs: [] };

function validTask(overrides = {}) {
  return { ref: 'orch/init', title: 'Init', status: 'todo', ...overrides };
}
function validFeature(overrides = {}) {
  return { ref: 'orch', title: 'Orchestration', tasks: [], ...overrides };
}
function validAgent(overrides = {}) {
  return { agent_id: 'agent-01', provider: 'claude', status: 'idle', registered_at: '2024-01-01T00:00:00Z', ...overrides };
}
function validClaim(overrides = {}) {
  return { run_id: 'run-abc123', task_ref: 'orch/init', agent_id: 'agent-01', state: 'claimed', claimed_at: '2024-01-01T00:00:00Z', lease_expires_at: '2024-01-01T01:00:00Z', ...overrides };
}

// ── validateBacklog ────────────────────────────────────────────────────────

describe('validateBacklog', () => {
  it('accepts valid empty backlog', () => {
    expect(validateBacklog(VALID_BACKLOG)).toEqual([]);
  });

  it('accepts backlog with features and tasks', () => {
    const data = { version: '1', features: [validFeature({ tasks: [validTask()] })] };
    expect(validateBacklog(data)).toEqual([]);
  });

  it('rejects missing version', () => {
    expect(validateBacklog({ features: [] })).toEqual(expect.arrayContaining([expect.stringContaining('version')]));
  });

  it('rejects wrong version', () => {
    expect(validateBacklog({ version: '2', features: [] })).toEqual(expect.arrayContaining([expect.stringContaining('version')]));
  });

  it('rejects non-array features', () => {
    expect(validateBacklog({ version: '1', features: null })).toEqual(expect.arrayContaining([expect.stringContaining('features')]));
  });

  it('rejects task with invalid status', () => {
    const data = { version: '1', features: [validFeature({ tasks: [validTask({ status: 'wip' })] })] };
    const errors = validateBacklog(data);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts all valid task statuses', () => {
    for (const status of ['todo', 'claimed', 'in_progress', 'blocked', 'done', 'released']) {
      const data = { version: '1', features: [validFeature({ tasks: [validTask({ status })] })] };
      expect(validateBacklog(data)).toEqual([]);
    }
  });
});

// ── validateAgents ─────────────────────────────────────────────────────────

describe('validateAgents', () => {
  it('accepts valid empty agents', () => {
    expect(validateAgents(VALID_AGENTS)).toEqual([]);
  });

  it('accepts valid agent entry', () => {
    expect(validateAgents({ version: '1', agents: [validAgent()] })).toEqual([]);
  });

  it('accepts all valid providers', () => {
    for (const provider of ['codex', 'claude', 'gemini', 'human']) {
      expect(validateAgents({ version: '1', agents: [validAgent({ provider })] })).toEqual([]);
    }
  });

  it('rejects unknown provider', () => {
    const errors = validateAgents({ version: '1', agents: [validAgent({ provider: 'openai' })] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid agent status', () => {
    const errors = validateAgents({ version: '1', agents: [validAgent({ status: 'busy' })] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects legacy owner/session-bound fields as additional properties', () => {
    const errors = validateAgents({
      version: '1',
      agents: [validAgent({
        owner_session_id: 'sess-123',
        owner_tty: '/dev/ttys001',
        owner_pid: 4321,
        owner_last_seen_at: '2024-01-01T00:00:00Z',
        session_bound: true,
      })],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('additional properties');
  });

  it('rejects agent missing agent_id', () => {
    const agent = { provider: 'claude', status: 'idle', registered_at: '2024-01-01T00:00:00Z' };
    const errors = validateAgents({ version: '1', agents: [agent] });
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('agent_id')]));
  });
});

// ── validateClaims ─────────────────────────────────────────────────────────

describe('validateClaims', () => {
  it('accepts valid empty claims', () => {
    expect(validateClaims(VALID_CLAIMS)).toEqual([]);
  });

  it('accepts valid claim', () => {
    expect(validateClaims({ version: '1', claims: [validClaim()] })).toEqual([]);
  });

  it('accepts claim waiting for input', () => {
    expect(validateClaims({
      version: '1',
      claims: [validClaim({
        state: 'in_progress',
        input_state: 'awaiting_input',
        input_requested_at: '2024-01-01T00:10:00Z',
      })],
    })).toEqual([]);
  });

  it('accepts all valid claim states', () => {
    for (const state of ['claimed', 'in_progress', 'done', 'failed']) {
      expect(validateClaims({ version: '1', claims: [validClaim({ state })] })).toEqual([]);
    }
  });

  it('rejects invalid claim state', () => {
    const errors = validateClaims({ version: '1', claims: [validClaim({ state: 'running' })] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects claim missing task_ref', () => {
    const claim = { run_id: 'run-x', agent_id: 'agent-01', state: 'claimed', claimed_at: '2024-01-01T00:00:00Z', lease_expires_at: '2024-01-01T01:00:00Z' };
    const errors = validateClaims({ version: '1', claims: [claim] });
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('task_ref')]));
  });
});

describe('validateRunWorktrees', () => {
  it('accepts valid empty run-worktrees metadata', () => {
    expect(validateRunWorktrees(VALID_RUN_WORKTREES)).toEqual([]);
  });

  it('rejects invalid task_ref values', () => {
    const errors = validateRunWorktrees({
      version: '1',
      runs: [{
        run_id: 'run-1',
        task_ref: 'invalid',
        agent_id: 'orc-1',
        branch: 'task/run-1',
        worktree_path: '/tmp/run-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ── validateStateDir ───────────────────────────────────────────────────────

describe('validateStateDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTempStateDir('orch-statedir-test-');
  });

  afterEach(() => {
    cleanupTempStateDir(dir);
  });

  it('returns no errors for a fully valid state directory', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(VALID_BACKLOG));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(VALID_AGENTS));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(VALID_CLAIMS));
    writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify(VALID_RUN_WORKTREES));
    writeFileSync(join(dir, 'events.jsonl'), '');

    expect(validateStateDir(dir)).toEqual([]);
  });

  it('reports missing files', () => {
    const errors = validateStateDir(dir);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('backlog.json: file not found'),
      expect.stringContaining('agents.json: file not found'),
      expect.stringContaining('events.db: file not found'),
    ]));
  });

  it('reports JSON parse errors', () => {
    writeFileSync(join(dir, 'backlog.json'), '{invalid json}');
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(VALID_AGENTS));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(VALID_CLAIMS));
    writeFileSync(join(dir, 'events.jsonl'), '');

    const errors = validateStateDir(dir);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('backlog.json: JSON parse error')]));
  });

  it('reports validation errors from individual files', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '2', features: [] }));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(VALID_AGENTS));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(VALID_CLAIMS));
    writeFileSync(join(dir, 'events.jsonl'), '');

    const errors = validateStateDir(dir);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('version')]));
  });

  it('reports validation errors from run-worktrees metadata when present', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(VALID_BACKLOG));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(VALID_AGENTS));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(VALID_CLAIMS));
    writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
      version: '1',
      runs: [{
        run_id: 'run-1',
        task_ref: 'invalid',
        agent_id: 'orc-1',
        branch: 'task/run-1',
        worktree_path: '/tmp/run-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }],
    }));
    writeFileSync(join(dir, 'events.jsonl'), '');

    const errors = validateStateDir(dir);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('run-worktrees')]));
  });

  it('reports cross-file invariant violations', () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(VALID_BACKLOG));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(VALID_AGENTS));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [validClaim({ task_ref: 'missing/task', agent_id: 'missing-agent' })],
    }));
    writeFileSync(join(dir, 'events.jsonl'), '');
    const errors = validateStateDir(dir);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('unknown task_ref'),
      expect.stringContaining('unknown agent_id'),
    ]));
  });
});
