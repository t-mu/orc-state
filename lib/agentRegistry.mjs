import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './lock.mjs';
import { atomicWriteJson } from './atomicWrite.mjs';
import { isSupportedProvider, loadWorkerPoolConfig } from './providers.mjs';

const VALID_ROLES = new Set(['worker', 'reviewer', 'master']);

function readAgents(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8'));
  } catch {
    return { version: '1', agents: [] };
  }
}

function lockPath(stateDir) {
  return join(stateDir, '.lock');
}

function createManagedSlotEntry(agentId, workerPoolConfig) {
  return {
    agent_id: agentId,
    provider: workerPoolConfig.provider,
    model: workerPoolConfig.model,
    dispatch_mode: null,
    role: 'worker',
    capabilities: [],
    status: 'idle',
    session_handle: null,
    provider_ref: null,
    last_heartbeat_at: null,
    registered_at: new Date().toISOString(),
  };
}

function managedWorkerIds(workerPoolConfig) {
  return Array.from(
    { length: workerPoolConfig.max_workers },
    (_, index) => `orc-${index + 1}`,
  );
}

function isManagedWorkerId(agentId) {
  return /^orc-\d+$/.test(agentId ?? '');
}

/**
 * Register a new agent in agents.json. Throws if agent_id already exists.
 *
 * @param {string} stateDir
 * @param {{ agent_id, provider, dispatch_mode? }} agentDef
 */
export function registerAgent(stateDir, agentDef) {
  const { agent_id, provider } = agentDef;
  if (!agent_id) throw new Error('agent_id is required');
  if (!provider) throw new Error('provider is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agent_id)) {
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
  if (!Array.isArray(capabilities) || capabilities.some((c) => !/^[a-z0-9][a-z0-9-]*$/.test(c))) {
    throw new Error('capabilities must be an array of kebab-case strings');
  }

  return withLock(lockPath(stateDir), () => {
    const file = readAgents(stateDir);

    if (file.agents.some(a => a.agent_id === agent_id)) {
      throw new Error(`Agent already registered: ${agent_id}`);
    }

    const entry = {
      agent_id,
      provider,
      model:            null,
      dispatch_mode:    agentDef.dispatch_mode ?? null,
      role,
      capabilities,
      status:           'idle',
      session_handle:   null,
      provider_ref:     agentDef.provider_ref ?? null,
      last_heartbeat_at: null,
      registered_at:    new Date().toISOString(),
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
export function updateAgentRuntime(stateDir, agentId, updates) {
  const ALLOWED = new Set([
    'status',
    'session_handle',
    'provider_ref',
    'last_heartbeat_at',
    'last_status_change_at',
  ]);

  withLock(lockPath(stateDir), () => {
    const file = readAgents(stateDir);
    const idx = file.agents.findIndex(a => a.agent_id === agentId);
    if (idx === -1) throw new Error(`Agent not found: ${agentId}`);

    for (const [key, val] of Object.entries(updates)) {
      if (ALLOWED.has(key)) file.agents[idx][key] = val;
    }

    atomicWriteJson(join(stateDir, 'agents.json'), file);
  });
}

/**
 * Return the agent record for agentId, or null if not found.
 */
export function getAgent(stateDir, agentId) {
  const file = readAgents(stateDir);
  return file.agents.find(a => a.agent_id === agentId) ?? null;
}

/**
 * Return all agent records.
 */
export function listAgents(stateDir) {
  return readAgents(stateDir).agents;
}

export function reconcileManagedWorkerSlots(stateDir, workerPoolConfig = loadWorkerPoolConfig()) {
  return withLock(lockPath(stateDir), () => {
    const file = readAgents(stateDir);
    let modified = false;

    for (const agentId of managedWorkerIds(workerPoolConfig)) {
      const existing = file.agents.find((agent) => agent.agent_id === agentId);
      if (!existing) {
        file.agents.push(createManagedSlotEntry(agentId, workerPoolConfig));
        modified = true;
        continue;
      }

      const canRefreshProviderBinding = existing.role !== 'master'
        && existing.session_handle == null
        && existing.status !== 'running';

      if (canRefreshProviderBinding && (
        existing.provider !== workerPoolConfig.provider
        || existing.model !== workerPoolConfig.model
      )) {
        existing.provider = workerPoolConfig.provider;
        existing.model = workerPoolConfig.model;
        modified = true;
      }
    }

    if (modified) {
      atomicWriteJson(join(stateDir, 'agents.json'), file);
    }

    return file.agents;
  });
}

export function listCoordinatorAgents(stateDir, workerPoolConfig = loadWorkerPoolConfig()) {
  const agents = readAgents(stateDir).agents;
  const byId = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const slotIds = new Set(managedWorkerIds(workerPoolConfig));
  const managedSlots = [...slotIds].map((agentId) =>
    byId.get(agentId) ?? createManagedSlotEntry(agentId, workerPoolConfig),
  );

  return [
    ...agents.filter((agent) => !isManagedWorkerId(agent.agent_id)),
    ...managedSlots,
  ];
}

/**
 * Remove an agent from the registry. No-op if agent_id is not found.
 */
export function removeAgent(stateDir, agentId) {
  withLock(lockPath(stateDir), () => {
    const file = readAgents(stateDir);
    file.agents = file.agents.filter(a => a.agent_id !== agentId);
    atomicWriteJson(join(stateDir, 'agents.json'), file);
  });
}

/**
 * Return next available worker id in the format orc-<N>, preferring the
 * smallest missing positive N among non-master agents.
 */
export function nextAvailableWorkerId(stateDir) {
  const used = new Set();
  for (const agent of listAgents(stateDir)) {
    if (agent.role === 'master') continue;
    const match = /^orc-(\d+)$/.exec(agent.agent_id ?? '');
    if (!match) continue;
    const num = Number(match[1]);
    if (Number.isInteger(num) && num > 0) used.add(num);
  }

  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return `orc-${candidate}`;
}
