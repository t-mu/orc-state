import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerAgent,
  updateAgentRuntime,
  getAgent,
  listAgents,
  listCoordinatorAgents,
  removeAgent,
  nextAvailableWorkerName,
  nextAvailableScoutId,
} from './agentRegistry.ts';
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
    expect(a.capabilities).toEqual([]);
    expect(a.status).toBe('idle');
    expect(a.session_handle).toBeNull();
    expect(a.provider_ref).toBeNull();
    expect(a.last_heartbeat_at).toBeNull();
    expect(a.registered_at).toBeTruthy();
  });

  it('persists optional dispatch_mode and keeps model unset', () => {
    registerAgent(dir, { agent_id: 'agent-01', provider: 'claude', dispatch_mode: 'autonomous' });
    const a = getAgent(dir, 'agent-01')!;
    expect(a.model).toBeNull();
    expect(a.dispatch_mode).toBe('autonomous');
  });

  it('persists reviewer role and capabilities when provided', () => {
    registerAgent(dir, {
      agent_id: 'reviewer-01',
      provider: 'claude',
      role: 'reviewer',
      capabilities: ['delegation', 'review'],
    });
    const a = getAgent(dir, 'reviewer-01')!;
    expect(a.role).toBe('reviewer');
    expect(a.capabilities).toEqual(['delegation', 'review']);
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
      session_handle: 'pty:agent-01',
      provider_ref: { pid: 99999, provider: 'claude', binary: 'claude' },
    });
    const a = getAgent(dir, 'agent-01')!;
    expect(a.session_handle).toBe('pty:agent-01');
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

// ── nextAvailableWorkerName ────────────────────────────────────────────────

describe('nextAvailableWorkerName', () => {
  it('allocates the first unused deterministic two-word worker name', () => {
    const name = nextAvailableWorkerName(dir);
    expect(name).toBe('amber-anchor');
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('skips names already in use by registered worker agents', () => {
    registerAgent(dir, { agent_id: 'amber-anchor', provider: 'claude', role: 'worker' });
    const name = nextAvailableWorkerName(dir);
    expect(name).toBe('amber-anvil');
  });

  it('reuses a worker name only after the prior live worker is removed', () => {
    registerAgent(dir, { agent_id: 'amber-anchor', provider: 'claude', role: 'worker' });
    expect(nextAvailableWorkerName(dir)).toBe('amber-anvil');

    removeAgent(dir, 'amber-anchor');
    expect(nextAvailableWorkerName(dir)).toBe('amber-anchor');
  });

  it('does not use names held by non-worker agents (master, scout)', () => {
    registerAgent(dir, { agent_id: 'master', provider: 'claude', role: 'master' });
    registerAgent(dir, { agent_id: 'scout-1', provider: 'codex', role: 'scout' });
    // Non-worker names do not affect worker name pool
    expect(nextAvailableWorkerName(dir)).toBe('amber-anchor');
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
