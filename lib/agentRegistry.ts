import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, lockPath } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { isSupportedProvider } from './providers.ts';
import type { Agent, AgentsState, AgentRole, Provider, DispatchMode } from '../types/agents.ts';
import { AGENT_ID_RE, AGENT_ROLES } from './constants.ts';
import { logger } from './logger.ts';
import { nextAvailableAgentName } from './agentNames.ts';

const VALID_ROLES = new Set<AgentRole>(AGENT_ROLES as AgentRole[]);

function readAgentsFile(stateDir: string): AgentsState {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8')) as AgentsState;
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
  dispatch_mode?: string | null;
  capabilities?: string[];
  provider_ref?: Record<string, unknown> | null;
  /** Mark this agent as coordinator-spawned ephemeral. Ephemeral workers are
   * removed from the registry when their task-scoped session is cleaned up. */
  ephemeral?: boolean;
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
  const capabilities = agentDef.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((c) => !AGENT_ID_RE.test(c))) {
    throw new Error('capabilities must be an array of kebab-case strings');
  }

  return withLock(lockPath(stateDir), () => {
    const file = readAgentsFile(stateDir);

    if (file.agents.some((a) => a.agent_id === agent_id)) {
      throw new Error(`Agent already registered: ${agent_id}`);
    }

    const entry: Agent = {
      agent_id,
      provider: provider as Provider,
      model:            null,
      dispatch_mode:    (agentDef.dispatch_mode ?? null) as DispatchMode | null,
      role,
      capabilities,
      status:           'idle',
      session_handle:   null,
      session_token:    null,
      session_started_at: null,
      session_ready_at: null,
      provider_ref:     agentDef.provider_ref ?? null,
      last_heartbeat_at: null,
      registered_at:    new Date().toISOString(),
      ...(agentDef.ephemeral ? { ephemeral: true } : {}),
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
    atomicWriteJson(join(stateDir, 'agents.json'), file);
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
