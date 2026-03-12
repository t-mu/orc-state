import { updateAgentRuntime } from './agentRegistry.ts';
import { buildSessionBootstrap } from './sessionBootstrap.ts';
import type { Agent } from '../types/agents.ts';
import type { OrcEventInput } from '../types/events.ts';

function reasonCode(reason: unknown): string {
  return `ERR_${String(reason ?? 'unknown').toUpperCase()}`;
}

function syncAgentRuntime(agent: Agent, updates: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(updates)) {
    (agent as unknown as Record<string, unknown>)[key] = value;
  }
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
  { status = 'idle' }: { status?: string } = {},
): void {
  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status,
    session_handle: null,
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
    payload: { reason, code: reasonCode(reason), ...payload },
  });
}

interface Adapter {
  start(agentId: string, options: {
    system_prompt: string;
    model: string | null;
    working_directory: string | null | undefined;
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
    retryable = false,
    emit,
  }: {
    adapter: Adapter;
    workingDirectory: string | null | undefined;
    repoRoot?: string | null;
    runId?: string | null;
    taskRef?: string | null;
    retryable?: boolean;
    emit: (event: OrcEventInput) => void;
  },
): Promise<{ ok: boolean; session_handle?: string; provider_ref?: unknown; reason?: string }> {
  try {
    const nowIso = new Date().toISOString();
    const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
      system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider, agent.role ?? 'worker'),
      model: agent.model ?? null,
      working_directory: workingDirectory ?? undefined,
      env: {
        ORCH_STATE_DIR: stateDir,
        ...(repoRoot ? { ORC_REPO_ROOT: repoRoot } : {}),
      },
    });
    const updates: Record<string, unknown> = {
      status: 'running',
      session_handle,
      provider_ref,
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
    emitSessionStartFailed(emit, agent, { runId, taskRef, reason, workingDirectory });
    if (retryable) {
      clearWorkerSessionRuntime(stateDir, agent, { status: 'idle' });
      return { ok: false, reason };
    }

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
