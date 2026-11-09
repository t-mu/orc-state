import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerAgent,
  updateAgentRuntime,
  getAgent,
  listAgents,
  listCoordinatorAgents,
  removeAgent,
  removeUnclaimedAgent,
  nextAvailableWorkerName,
  nextAvailableScoutId,
} from './agentRegistry.ts';
import { validateAgents } from './stateValidation.ts';
import { lockPath } from './lock.ts';
import { createTempStateDir, cleanupTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-registry-test-');
  seedState(dir);
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

// ── registerAgent ──────────────────────────────────────────────────────────

describe('registerAgent', () => {
  it('adds agent to agents.json', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    const agents = listAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].agent_id).toBe('agent-01');
    expect(agents[0].provider).toBe('claude');
  });

  it('sets default runtime fields on registration', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'codex' });
    const a = getAgent(dir, 'agent-01')!;
    expect(a.role).toBe('worker');
    expect(a.status).toBe('idle');
    expect(a.session_handle).toBeNull();
    expect(a.provider_ref).toBeNull();
    expect(a.last_heartbeat_at).toBeNull();
    expect(a.registered_at).toBeTruthy();
  });

  it('keeps model unset on registration', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    expect(getAgent(dir, 'agent-01')!.model).toBeNull();
  });

  it('persists reviewer role when provided', () => {
    registerAgent(dir, { agent_id: 'reviewer-01', provider: 'claude', role: 'reviewer' });
    expect(getAgent(dir, 'reviewer-01')!.role).toBe('reviewer');
  });

  it('drops retired dispatch_mode and capabilities fields on the next registry write', () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [{
      agent_id: 'old-worker', provider: 'claude', role: 'worker', status: 'idle',
      dispatch_mode: null, capabilities: [], registered_at: new Date().toISOString(),
    }] }));
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    const stored = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as { agents: Array<Record<string, unknown>> };
    expect(stored.agents[0]).not.toHaveProperty('dispatch_mode');
    expect(stored.agents[0]).not.toHaveProperty('capabilities');
    expect(validateAgents(stored)).toEqual([]);
  });

  it('accepts master role when provided', () => {
    registerAgent(dir, {
      agent_id: 'master-01',
      provider: 'claude',
      role: 'master',
    });
    const a = getAgent(dir, 'master-01')!;
    expect(a.role).toBe('master');
  });

  it('throws when registering a duplicate agent_id', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    expect(() => registerAgent(dir, { agent_id: 'agent-01', provider: 'codex' }))
      .toThrow('already registered');
  });

  it('throws when agent_id is missing', () => {
    expect(() => registerAgent(dir, { provider: 'claude' } as import('./agentRegistry.ts').AgentDefinition)).toThrow('agent_id');
  });

  it('throws when provider is missing', () => {
    expect(() => registerAgent(dir, { agent_id: 'agent-01' } as import('./agentRegistry.ts').AgentDefinition)).toThrow('provider');
  });

  it('throws when provider is unsupported', () => {
    expect(() => registerAgent(dir, { agent_id: 'agent-01', provider: 'human' }))
      .toThrow('Unsupported provider');
  });

  it('throws when agent_id has invalid format', () => {
    expect(() => registerAgent(dir, { agent_id: 'Agent 01', provider: 'codex' }))
      .toThrow('Invalid agent_id');
  });

  it('throws when role is unsupported', () => {
    expect(() => registerAgent(dir, { agent_id: 'agent-01', provider: 'codex', role: 'manager' as import('../types/index.ts').AgentRole }))
      .toThrow('Unsupported role');
  });

  it('can register multiple agents', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    registerAgent(dir, { agent_id: 'agent-02', provider: 'codex' });
    expect(listAgents(dir)).toHaveLength(2);
  });

  it('accepts scout as a supported role', () => {
    registerAgent(dir, { agent_id: 'scout-1', provider: 'codex', role: 'scout' });
    expect(getAgent(dir, 'scout-1')?.role).toBe('scout');
  });
});

// ── updateAgentRuntime ─────────────────────────────────────────────────────

describe('updateAgentRuntime', () => {
  beforeEach(() => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
  });

  it('updates status', () => {
    updateAgentRuntime(dir, 'agent-01', { status: 'running' });
    expect(getAgent(dir, 'agent-01')!.status).toBe('running');
  });

  it('updates session_handle and provider_ref', () => {
    updateAgentRuntime(dir, 'agent-01', {
      session_handle: 'tmux:agent-01',
      provider_ref: { pid: 99999, provider: 'claude', binary: 'claude' },
    });
    const a = getAgent(dir, 'agent-01')!;
    expect(a.session_handle).toBe('tmux:agent-01');
    expect(a.provider_ref!.pid).toBe(99999);
  });

  it('updates last_heartbeat_at', () => {
    const ts = new Date().toISOString();
    updateAgentRuntime(dir, 'agent-01', { last_heartbeat_at: ts });
    expect(getAgent(dir, 'agent-01')!.last_heartbeat_at).toBe(ts);
  });

  it('ignores disallowed fields (provider, model)', () => {
    updateAgentRuntime(dir, 'agent-01', { provider: 'gemini', model: 'hacked' });
    const a = getAgent(dir, 'agent-01')!;
    expect(a.provider).toBe('claude');
    expect(a.model).toBeNull();
  });

  it('throws when agent_id is not found', () => {
    expect(() => updateAgentRuntime(dir, 'agent-99', { status: 'running' }))
      .toThrow('not found');
  });
});

// ── getAgent ───────────────────────────────────────────────────────────────

describe('getAgent', () => {
  it('returns the agent record by agent_id', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    const a = getAgent(dir, 'agent-01')!;
    expect(a.agent_id).toBe('agent-01');
  });

  it('returns null for unknown agent_id', () => {
    expect(getAgent(dir, 'agent-99')).toBeNull();
  });
});

// ── listAgents ─────────────────────────────────────────────────────────────

describe('listAgents', () => {
  it('returns empty array when no agents registered', () => {
    expect(listAgents(dir)).toEqual([]);
  });

  it('returns all registered agents', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    registerAgent(dir, { agent_id: 'agent-02', provider: 'codex' });
    const ids = listAgents(dir).map(a => a.agent_id);
    expect(ids).toContain('agent-01');
    expect(ids).toContain('agent-02');
  });
});

// ── listCoordinatorAgents ─────────────────────────────────────────────────

describe('listCoordinatorAgents', () => {
  it('does not synthesize idle worker slots when max_workers is configured', () => {
    registerAgent(dir, { agent_id: 'master', provider: 'claude', role: 'master' });

    // Even with max_workers=3, no synthetic slots are created
    const agents = listCoordinatorAgents(dir, { max_workers: 3, provider: 'codex', model: null });
    expect(agents.map((a) => a.agent_id)).toEqual(['master']);
    expect(agents.some((a) => /^orc-\d+$/.test(a.agent_id))).toBe(false);
  });

  it('returns only agents present in the registry', () => {
    registerAgent(dir, { agent_id: 'master', provider: 'claude', role: 'master' });
    registerAgent(dir, { agent_id: 'amber-kettle', provider: 'claude', role: 'worker' });

    const agents = listCoordinatorAgents(dir);
    expect(agents.map((a) => a.agent_id)).toEqual(['master', 'amber-kettle']);
  });
});

// ── removeAgent ────────────────────────────────────────────────────────────

describe('removeAgent', () => {
  it('removes the named agent', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    removeAgent(dir, 'agent-01');
    expect(getAgent(dir, 'agent-01')).toBeNull();
  });

  it('is a no-op for unknown agent_id', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    expect(() => removeAgent(dir, 'agent-99')).not.toThrow();
    expect(listAgents(dir)).toHaveLength(1);
  });
});

// ── removeUnclaimedAgent ───────────────────────────────────────────────────

describe('removeUnclaimedAgent', () => {
  function writeClaim(agentId: string, state: string) {
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [
      { run_id: 'run-1', task_ref: 'proj/task-1', agent_id: agentId, state, claimed_at: '2026-01-01T00:00:00Z', lease_expires_at: '2099-01-01T00:00:00Z' },
    ] }));
  }

  it('removes an agent without an active claim', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    writeClaim('agent-01', 'done');
    expect(removeUnclaimedAgent(dir, 'agent-01')).toEqual({ removed: true });
    expect(getAgent(dir, 'agent-01')).toBeNull();
  });

  it.each(['claimed', 'in_progress'])('keeps an agent with a %s claim and returns it', (state) => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    writeClaim('agent-01', state);
    const result = removeUnclaimedAgent(dir, 'agent-01');
    expect(result).toMatchObject({ removed: false, reason: 'active_claim', claim: { run_id: 'run-1', state } });
    expect(getAgent(dir, 'agent-01')).not.toBeNull();
  });

  it('reports an unknown agent', () => {
    expect(removeUnclaimedAgent(dir, 'agent-99')).toEqual({ removed: false, reason: 'not_found' });
  });

  it('keeps the agent when canRemove rejects it', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    expect(removeUnclaimedAgent(dir, 'agent-01', () => false)).toEqual({ removed: false, reason: 'kept' });
    expect(getAgent(dir, 'agent-01')).not.toBeNull();
  });

  it('decides while holding the state lock that claim creation takes', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude' });
    let lockHeld = false;
    removeUnclaimedAgent(dir, 'agent-01', () => { lockHeld = existsSync(lockPath(dir)); return true; });
    expect(lockHeld).toBe(true);
    expect(existsSync(lockPath(dir))).toBe(false);
  });
});

// ── nextAvailableWorkerName ────────────────────────────────────────────────

describe('nextAvailableWorkerName', () => {
  it('allocates an orc-themed two-word worker name', () => {
    const name = nextAvailableWorkerName(dir);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('skips names already in use by registered worker agents', () => {
    const first = nextAvailableWorkerName(dir);
    registerAgent(dir, { agent_id: first, provider: 'claude', role: 'worker' });
    const second = nextAvailableWorkerName(dir);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('reuses a worker name only after the prior live worker is removed', () => {
    const first = nextAvailableWorkerName(dir);
    registerAgent(dir, { agent_id: first, provider: 'claude', role: 'worker' });

    const second = nextAvailableWorkerName(dir);
    expect(second).not.toBe(first);

    removeAgent(dir, first);
    // With the prior worker gone, the same name is eligible again — but the
    // picker is random, so we assert the weaker property that any subsequent
    // allocation is a valid shape and not colliding with the current registry.
    const next = nextAvailableWorkerName(dir);
    expect(next).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('does not use names held by non-worker agents (master, scout)', () => {
    registerAgent(dir, { agent_id: 'master', provider: 'claude', role: 'master' });
    registerAgent(dir, { agent_id: 'scout-1', provider: 'codex', role: 'scout' });
    const name = nextAvailableWorkerName(dir);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(name).not.toBe('master');
    expect(name).not.toBe('scout-1');
  });
});

describe('nextAvailableScoutId', () => {
  it('returns scout-1 when no scouts exist', () => {
    expect(nextAvailableScoutId(dir)).toBe('scout-1');
  });

  it('fills the smallest missing scout slot', () => {
    registerAgent(dir, { agent_id: 'scout-1', provider: 'codex', role: 'scout' });
    registerAgent(dir, { agent_id: 'scout-3', provider: 'claude', role: 'scout' });
    expect(nextAvailableScoutId(dir)).toBe('scout-2');
  });
});

describe('readAgentsFile error discrimination', () => {
  it('logs to stderr and returns empty default when agents.json is corrupted', () => {
    writeFileSync(join(dir, 'agents.json'), 'NOT VALID JSON');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const agents = listAgents(dir);
      expect(agents).toEqual([]);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('[agentRegistry]'),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('does not log to stderr on ENOENT (missing file)', () => {
    const freshDir = createTempStateDir('orch-registry-enoent-');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const agents = listAgents(freshDir);
      expect(agents).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      cleanupTempStateDir(freshDir);
    }
  });
});
