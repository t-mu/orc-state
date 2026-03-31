import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';

export interface OrphanedClaim {
  run_id: string;
  task_ref: string;
  agent_id: string;
  claim_state: string;
  owner_status: string;
}

export function getOrphanedClaims(agents: Agent[], claims: Claim[]): OrphanedClaim[] {
  const out: OrphanedClaim[] = [];
  for (const claim of claims) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;
    const owner = agents.find((a) => a.agent_id === claim.agent_id);
    if (!owner || owner.status === 'offline') {
      out.push({
        run_id: claim.run_id,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        claim_state: claim.state,
        owner_status: owner?.status ?? 'missing',
      });
    }
  }
  return out;
}
