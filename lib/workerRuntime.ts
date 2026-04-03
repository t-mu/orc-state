import { updateAgentRuntime } from './agentRegistry.ts';
import { resolveOrcBin } from './orcBin.ts';
import { buildSessionBootstrap } from './sessionBootstrap.ts';
import type { Agent, AgentStatus } from '../types/agents.ts';
import type { OrcEventInput } from '../types/events.ts';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function syncAgentRuntime(agent: Agent, updates: Partial<Agent>): void {
  Object.assign(agent, updates);
}

function withPrependedPath(pathValue: string | undefined, entry: string): string {
  const segments = (pathValue ?? '').split(delimiter).filter(Boolean);
  if (segments.includes(entry)) return pathValue ?? entry;
  return [entry, ...segments].join(delimiter);
}

export function normalizeWorkerEnv(baseEnv: NodeJS.ProcessEnv, repoRoot: string | null = null): Record<string, string> {
  const env = { ...baseEnv } as Record<string, string>;
  const localBin = repoRoot ? join(repoRoot, 'node_modules', '.bin') : '';
  if (localBin && existsSync(localBin)) {
    env.PATH = withPrependedPath(env.PATH ?? process.env.PATH ?? '', localBin);
  }
  const home = env.HOME ?? process.env.HOME ?? '';
  const npmGlobalBin = home ? join(home, '.npm-global', 'bin') : '';
  if (npmGlobalBin && existsSync(npmGlobalBin)) {
    env.PATH = withPrependedPath(env.PATH ?? process.env.PATH ?? '', npmGlobalBin);
  } else if (env.PATH == null && process.env.PATH) {
    env.PATH = process.env.PATH;
  }
  if (repoRoot) {
    env.ORC_REPO_ROOT = repoRoot;
  }
  // Prevent interactive editors, pagers, and merge-tool prompts from blocking
  // headless PTY sessions. Workers never need an interactive editor.
  env.EDITOR = 'true';
  env.GIT_EDITOR = 'true';
  env.PAGER = 'cat';
  env.ORC_BIN = resolveOrcBin(repoRoot, env);
  return env;
}

function emitSessionStartFailed(
  emit: (event: OrcEventInput) => void,
  agent: Agent,
  { runId, taskRef, reason, workingDirectory }: {
    runId: string | null;
    taskRef: string | null;
    reason: string;
    workingDirectory: string | null | undefined;
  },
): void {
  if (!runId || !taskRef) return;
  emit({
    ts: new Date().toISOString(),
    event: 'session_start_failed',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    run_id: runId,
    task_ref: taskRef,
    agent_id: agent.agent_id,
    payload: {
      reason,
      code: 'ERR_SESSION_START_FAILED',
      working_directory: workingDirectory ?? undefined,
    },
  });
}

export function clearWorkerSessionRuntime(
  stateDir: string,
  agent: Agent,
  { status = 'idle' }: { status?: AgentStatus } = {},
): void {
  const nowIso = new Date().toISOString();
  const updates: Partial<Agent> = {
    status,
    session_handle: null,
    session_token: null,
    session_started_at: null,
    session_ready_at: null,
    provider_ref: null,
    last_status_change_at: nowIso,
  };
  updateAgentRuntime(stateDir, agent.agent_id, updates);
  syncAgentRuntime(agent, updates);
}

export function markWorkerOffline(
  stateDir: string,
  agent: Agent,
  { emit, reason, payload = {} }: {
    emit: (event: OrcEventInput) => void;
    reason: string;
    payload?: Record<string, unknown>;
  },
): void {
  clearWorkerSessionRuntime(stateDir, agent, { status: 'offline' });
  emit({
    ts: new Date().toISOString(),
    event: 'agent_offline',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    agent_id: agent.agent_id,
    payload: { reason, code: `ERR_${String(reason ?? 'unknown').toUpperCase()}`, ...payload },
  });
}

interface Adapter {
  start(agentId: string, options: {
    system_prompt: string;
    model: string | null;
    working_directory: string | null | undefined;
    read_only?: boolean;
    execution_mode?: 'full-access' | 'sandbox';
    env: Record<string, string>;
  }): Promise<{ session_handle: string; provider_ref: unknown }>;
}

export async function launchWorkerSession(
  stateDir: string,
  agent: Agent,
  {
    adapter,
    workingDirectory,
    repoRoot = null,
    runId = null,
    taskRef = null,
    taskModel = null,
    retryable = false,
    emit,
    sessionToken = randomUUID(),
  }: {
    adapter: Adapter;
    workingDirectory: string | null | undefined;
    repoRoot?: string | null;
    runId?: string | null;
    taskRef?: string | null;
    taskModel?: string | null;
    retryable?: boolean;
    emit: (event: OrcEventInput) => void;
    sessionToken?: string;
  },
): Promise<{ ok: boolean; session_handle?: string; provider_ref?: unknown; reason?: string }> {
  try {
    const nowIso = new Date().toISOString();
    const workerEnv = normalizeWorkerEnv({
      ORCH_STATE_DIR: stateDir,
    }, repoRoot);
    const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
      system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider, agent.role ?? 'worker', workerEnv.ORC_BIN ?? 'orc', sessionToken),
      model: taskModel ?? agent.model ?? null,
      working_directory: workingDirectory ?? undefined,
      read_only: agent.role === 'scout',
      env: workerEnv,
    });
    const updates: Partial<Agent> = {
      status: 'running',
      session_handle,
      session_token: sessionToken,
      session_started_at: nowIso,
      session_ready_at: null,
      provider_ref: provider_ref as Agent['provider_ref'],
      last_heartbeat_at: nowIso,
      last_status_change_at: nowIso,
    };
    updateAgentRuntime(stateDir, agent.agent_id, updates);
    syncAgentRuntime(agent, updates);
    emit({
      ts: new Date().toISOString(),
      event: 'agent_online',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      ...(runId != null ? { run_id: runId } : {}),
      ...(taskRef != null ? { task_ref: taskRef } : {}),
      agent_id: agent.agent_id,
      payload: {
        session_handle,
        provider_ref,
        working_directory: workingDirectory ?? undefined,
      },
    });
    return { ok: true, session_handle, provider_ref };
  } catch (error) {
    const reason = (error as Error)?.message ?? String(error);
    if (retryable) {
      clearWorkerSessionRuntime(stateDir, agent, { status: 'idle' });
      return { ok: false, reason };
    }

    emitSessionStartFailed(emit, agent, { runId, taskRef, reason, workingDirectory });
    markWorkerOffline(stateDir, agent, {
      emit,
      reason: 'session_start_failed',
      payload: {
        message: reason,
        working_directory: workingDirectory ?? undefined,
      },
    });
    return { ok: false, reason };
  }
}
