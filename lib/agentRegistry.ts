import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, lockPath } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { isSupportedProvider } from './providers.ts';
import type { Agent, AgentsState, AgentRole, Provider } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';
import { readClaims } from './stateReader.ts';
import { AGENT_ID_RE, AGENT_ROLES } from './constants.ts';
import { logger } from './logger.ts';
import { nextAvailableAgentName } from './agentNames.ts';
import { closeProviderSessionsForAgent, withAuthoritativeAgentSessions } from './runStore.ts';

const VALID_ROLES = new Set<AgentRole>(AGENT_ROLES as AgentRole[]);

// Fields earlier registries wrote on every agent; dropped on read so the next
// registry write leaves agents.json valid against the current schema.
const RETIRED_AGENT_FIELDS = ['dispatch_mode', 'capabilities'];

function readAgentsFile(stateDir: string): AgentsState {
  try {
    const file = JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8')) as AgentsState;
    for (const agent of file.agents ?? []) {
      for (const field of RETIRED_AGENT_FIELDS) delete (agent as unknown as Record<string, unknown>)[field];
    }
    return withAuthoritativeAgentSessions(stateDir, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('[agentRegistry] unexpected error reading agents.json:', err);
    }
    return { version: '1', agents: [] };
  }
}

export interface AgentDefinition {
  agent_id: string;
  provider: string;
  role?: AgentRole;
  provider_ref?: Record<string, unknown> | null;
  /** Mark this agent as coordinator-spawned ephemeral. Ephemeral workers are
   * removed from the registry when their task-scoped session is cleaned up. */
  ephemeral?: boolean;
  /** The model the session is launched with (null: the provider CLI's default). */
  model?: string | null;
  /** A scout's objective, recorded as given (the caller caps it). */
  objective?: string;
}

/**
 * Register a new agent in agents.json. Throws if agent_id already exists.
 */
export function registerAgent(stateDir: string, agentDef: AgentDefinition): Agent {
  const { agent_id, provider } = agentDef;
  if (!agent_id) throw new Error('agent_id is required');
  if (!provider) throw new Error('provider is required');
  if (!AGENT_ID_RE.test(agent_id)) {
    throw new Error(`Invalid agent_id: ${agent_id}`);
  }
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  const role = agentDef.role ?? 'worker';
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Unsupported role: ${role}`);
  }

  return withLock(lockPath(stateDir), () => {
    const file = readAgentsFile(stateDir);

    if (file.agents.some((a) => a.agent_id === agent_id)) {
      throw new Error(`Agent already registered: ${agent_id}`);
    }

    const entry: Agent = {
      agent_id,
      provider: provider as Provider,
      model:            agentDef.model ?? null,
      role,
      status:           'idle',
      session_handle:   null,
      session_token:    null,
      session_started_at: null,
      session_ready_at: null,
      provider_ref:     agentDef.provider_ref ?? null,
      last_heartbeat_at: null,
      registered_at:    new Date().toISOString(),
      ...(agentDef.ephemeral ? { ephemeral: true } : {}),
      ...(agentDef.objective !== undefined ? { objective: agentDef.objective } : {}),
    };

    file.agents.push(entry);
    atomicWriteJson(join(stateDir, 'agents.json'), file);
    return entry;
  });
}

/**
 * Update runtime fields for an existing agent (status, session_handle,
 * provider_ref, last_heartbeat_at). Non-runtime fields (provider, model)
 * are not writable through this function.
 */
export function updateAgentRuntime(stateDir: string, agentId: string, updates: Partial<Agent>): void {
  const ALLOWED = new Set([
    'status',
    'session_handle',
    'session_token',
    'session_started_at',
    'session_ready_at',
    'provider_ref',
    'last_heartbeat_at',
    'last_status_change_at',
  ]);

  withLock(lockPath(stateDir), () => {
    const file = readAgentsFile(stateDir);
    const idx = file.agents.findIndex((a) => a.agent_id === agentId);
    if (idx === -1) throw new Error(`Agent not found: ${agentId}`);

    const filtered = Object.fromEntries(
      Object.entries(updates).filter(([key]) => ALLOWED.has(key)),
    ) as Partial<Agent>;
    Object.assign(file.agents[idx], filtered);

    if (filtered.session_handle === null || filtered.status === 'offline' || filtered.status === 'dead') {
      closeProviderSessionsForAgent(stateDir, agentId, new Date().toISOString());
    }

    atomicWriteJson(join(stateDir, 'agents.json'), file);
  });
}

/**
 * Return the agent record for agentId, or null if not found.
 */
export function getAgent(stateDir: string, agentId: string): Agent | null {
  const file = readAgentsFile(stateDir);
  return file.agents.find((a) => a.agent_id === agentId) ?? null;
}

/**
 * Return all agent records.
 */
export function listAgents(stateDir: string): Agent[] {
  return readAgentsFile(stateDir).agents;
}

/**
 * Return all coordinator-visible agents. In the ephemeral worker model, agents
 * exist only when a live session exists — this returns the registry as-is with
 * no virtual slot synthesis.
 */
export function listCoordinatorAgents(
  stateDir: string,
  // workerPoolConfig retained for call-site compatibility; no longer used for
  // slot synthesis.
  _workerPoolConfig?: unknown,
): Agent[] {
  return listAgents(stateDir);
}

/**
 * Remove an agent from the registry. No-op if agent_id is not found.
 */
export function removeAgent(stateDir: string, agentId: string): void {
  withLock(lockPath(stateDir), () => {
    const file = readAgentsFile(stateDir);
    file.agents = file.agents.filter((a) => a.agent_id !== agentId);
    closeProviderSessionsForAgent(stateDir, agentId, new Date().toISOString());
    atomicWriteJson(join(stateDir, 'agents.json'), file);
  });
}

/**
 * Remove an agent unless it holds an active (claimed / in_progress) claim,
 * checking the claims and the registry in the same locked section that
 * removes it. Claims are created under this lock (claimTask), so a claim
 * created concurrently is either seen here and blocks the removal, or is
 * created after the agent is gone. `canRemove` re-checks the agent record
 * under the lock (for example its status); returning false keeps it.
 */
export function removeUnclaimedAgent(
  stateDir: string,
  agentId: string,
  canRemove: (agent: Agent) => boolean = () => true,
): { removed: true } | { removed: false; reason: 'not_found' | 'kept' } | { removed: false; reason: 'active_claim'; claim: Claim } {
  return withLock(lockPath(stateDir), () => {
    const file = readAgentsFile(stateDir);
    const agent = file.agents.find((a) => a.agent_id === agentId);
    if (!agent) return { removed: false, reason: 'not_found' } as const;
    const claim = (readClaims(stateDir).claims ?? []).find((c) =>
      c.agent_id === agentId && ['claimed', 'in_progress'].includes(c.state),
    );
    if (claim) return { removed: false, reason: 'active_claim', claim } as const;
    if (!canRemove(agent)) return { removed: false, reason: 'kept' } as const;
    file.agents = file.agents.filter((a) => a.agent_id !== agentId);
    closeProviderSessionsForAgent(stateDir, agentId, new Date().toISOString());
    atomicWriteJson(join(stateDir, 'agents.json'), file);
    return { removed: true } as const;
  });
}

/**
 * Return a random orc-themed two-word worker name that is not currently in
 * use by any registered worker agent. The picker draws a random
 * `(first, second)` pair, retries on collision, then falls back to a
 * deterministic scan of the remaining pool before throwing on true exhaustion.
 *
 * Names are unique only among agents currently in the registry. Removing a
 * worker frees its name for reuse.
 *
 * Note: there is a small race window between this read and the subsequent
 * `registerAgent` call. Callers that need atomicity must use a single
 * `withLock` block, or tolerate the duplicate-registration error thrown by
 * `registerAgent` and retry with a fresh name.
 */
export function nextAvailableWorkerName(stateDir: string): string {
  return withLock(lockPath(stateDir), () => {
    const agents = readAgentsFile(stateDir).agents;
    const inUse = new Set(
      agents.filter((a) => a.role === 'worker').map((a) => a.agent_id),
    );
    return nextAvailableAgentName(inUse);
  });
}

export function nextAvailableScoutId(stateDir: string): string {
  const used = new Set<number>();
  for (const agent of listAgents(stateDir)) {
    const match = /^scout-(\d+)$/.exec(agent.agent_id ?? '');
    if (!match) continue;
    const num = Number(match[1]);
    if (Number.isInteger(num) && num > 0) used.add(num);
  }

  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return `scout-${candidate}`;
}
