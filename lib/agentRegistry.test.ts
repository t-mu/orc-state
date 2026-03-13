import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerAgent,
  updateAgentRuntime,
  getAgent,
  listAgents,
  listCoordinatorAgents,
  removeAgent,
  reconcileManagedWorkerSlots,
  nextAvailableWorkerId,
} from './agentRegistry.ts';

function seedDir(dir: string) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-registry-test-'));
  seedDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

describe('managed worker slots', () => {
  it('reconciles missing config-backed worker slots into agents.json', () => {
    registerAgent(dir, { agent_id: 'master', provider: 'claude', role: 'master' });

    reconcileManagedWorkerSlots(dir, { max_workers: 2, provider: 'codex', model: null });

    expect(listAgents(dir).map((agent) => agent.agent_id)).toEqual(['master', 'orc-1', 'orc-2']);
    expect(getAgent(dir, 'orc-1')?.provider).toBe('codex');
    expect(getAgent(dir, 'orc-2')?.role).toBe('worker');
  });

  it('returns a coordinator view with legacy agents plus configured slots', () => {
    registerAgent(dir, { agent_id: 'master', provider: 'claude', role: 'master' });
    registerAgent(dir, { agent_id: 'reviewer-01', provider: 'claude', role: 'reviewer' });
    registerAgent(dir, { agent_id: 'legacy-worker', provider: 'gemini', role: 'worker' });
    registerAgent(dir, { agent_id: 'orc-1', provider: 'claude', role: 'worker' });

    const agents = listCoordinatorAgents(dir, { max_workers: 2, provider: 'codex', model: null });

    expect(agents.map((agent) => agent.agent_id)).toEqual(['master', 'reviewer-01', 'legacy-worker', 'orc-1', 'orc-2']);
    expect(agents.find((agent) => agent.agent_id === 'orc-1')?.provider).toBe('claude');
    expect(agents.find((agent) => agent.agent_id === 'orc-2')?.provider).toBe('codex');
  });

  it('refreshes provider bindings for idle managed slots from config', () => {
    registerAgent(dir, { agent_id: 'orc-1', provider: 'claude', role: 'worker' });

    reconcileManagedWorkerSlots(dir, { max_workers: 1, provider: 'gemini', model: 'gemini-2.5-pro' });

    const slot = getAgent(dir, 'orc-1');
    expect(slot?.provider).toBe('gemini');
    expect(slot?.model).toBe('gemini-2.5-pro');
  });

  it('removes out-of-range managed slots from the coordinator view when capacity shrinks', () => {
    registerAgent(dir, { agent_id: 'orc-1', provider: 'codex', role: 'worker' });
    registerAgent(dir, { agent_id: 'orc-2', provider: 'codex', role: 'worker' });
    registerAgent(dir, { agent_id: 'legacy-worker', provider: 'claude', role: 'worker' });

    const agents = listCoordinatorAgents(dir, { max_workers: 1, provider: 'codex', model: null });

    expect(agents.map((agent) => agent.agent_id)).toEqual(['legacy-worker', 'orc-1']);
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

// ── nextAvailableWorkerId ──────────────────────────────────────────────────

describe('nextAvailableWorkerId', () => {
  it('returns orc-1 when no workers exist', () => {
    expect(nextAvailableWorkerId(dir)).toBe('orc-1');
  });

  it('returns next number when sequence is contiguous', () => {
    registerAgent(dir, { agent_id: 'orc-1', provider: 'claude', role: 'worker' });
    registerAgent(dir, { agent_id: 'orc-2', provider: 'codex', role: 'worker' });
    expect(nextAvailableWorkerId(dir)).toBe('orc-3');
  });

  it('reuses gaps in numbering', () => {
    registerAgent(dir, { agent_id: 'orc-1', provider: 'claude', role: 'worker' });
    registerAgent(dir, { agent_id: 'orc-3', provider: 'codex', role: 'worker' });
    expect(nextAvailableWorkerId(dir)).toBe('orc-2');
  });

  it('ignores master and non-orc ids', () => {
    registerAgent(dir, { agent_id: 'master', provider: 'claude', role: 'master' });
    registerAgent(dir, { agent_id: 'alice', provider: 'codex', role: 'worker' });
    registerAgent(dir, { agent_id: 'orc-2', provider: 'gemini', role: 'worker' });
    expect(nextAvailableWorkerId(dir)).toBe('orc-1');
  });
});
