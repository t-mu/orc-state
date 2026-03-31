import { describe, it, expect } from 'vitest';
import { getOrphanedClaims } from './claimDiagnostics.ts';
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';

function makeAgent(partial: Partial<Agent> & { agent_id: string; status: Agent['status'] }): Agent {
  return {
    provider: 'claude',
    registered_at: '2026-01-01T00:00:00Z',
    ...partial,
  } as Agent;
}

function makeClaim(partial: Partial<Claim> & { run_id: string; task_ref: string; agent_id: string; state: Claim['state'] }): Claim {
  return {
    claimed_at: '2026-01-01T00:00:00Z',
    lease_expires_at: '2099-01-01T00:00:00Z',
    ...partial,
  } as Claim;
}

describe('getOrphanedClaims', () => {
  it('returns empty array when all active claims have online owners', () => {
    const agents = [makeAgent({ agent_id: 'a1', status: 'running' })];
    const claims = [makeClaim({ run_id: 'r1', task_ref: 'f/t1', agent_id: 'a1', state: 'in_progress' })];
    expect(getOrphanedClaims(agents, claims)).toEqual([]);
  });

  it('flags claim whose agent is missing', () => {
    const agents: Agent[] = [];
    const claims = [makeClaim({ run_id: 'r1', task_ref: 'f/t1', agent_id: 'ghost', state: 'claimed' })];
    const result = getOrphanedClaims(agents, claims);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      run_id: 'r1',
      task_ref: 'f/t1',
      agent_id: 'ghost',
      claim_state: 'claimed',
      owner_status: 'missing',
    });
  });

  it('flags claim whose agent is offline', () => {
    const agents = [makeAgent({ agent_id: 'a1', status: 'offline' })];
    const claims = [makeClaim({ run_id: 'r1', task_ref: 'f/t1', agent_id: 'a1', state: 'in_progress' })];
    const result = getOrphanedClaims(agents, claims);
    expect(result).toHaveLength(1);
    expect(result[0].owner_status).toBe('offline');
  });

  it('ignores claims in terminal states', () => {
    const agents: Agent[] = [];
    const claims = [
      makeClaim({ run_id: 'r1', task_ref: 'f/t1', agent_id: 'gone', state: 'done' }),
      makeClaim({ run_id: 'r2', task_ref: 'f/t2', agent_id: 'gone', state: 'failed' }),
      makeClaim({ run_id: 'r3', task_ref: 'f/t3', agent_id: 'gone', state: 'released' }),
    ];
    expect(getOrphanedClaims(agents, claims)).toEqual([]);
  });

  it('returns multiple orphaned claims', () => {
    const agents: Agent[] = [];
    const claims = [
      makeClaim({ run_id: 'r1', task_ref: 'f/t1', agent_id: 'a1', state: 'claimed' }),
      makeClaim({ run_id: 'r2', task_ref: 'f/t2', agent_id: 'a2', state: 'in_progress' }),
    ];
    expect(getOrphanedClaims(agents, claims)).toHaveLength(2);
  });
});
