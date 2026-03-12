import { updateAgentRuntime } from './agentRegistry.mjs';
import { buildSessionBootstrap } from './sessionBootstrap.mjs';

function reasonCode(reason) {
  return `ERR_${String(reason ?? 'unknown').toUpperCase()}`;
}

function syncAgentRuntime(agent, updates) {
  for (const [key, value] of Object.entries(updates)) {
    agent[key] = value;
  }
}

function emitSessionStartFailed(emit, agent, { runId, taskRef, reason, workingDirectory }) {
  if (!runId || !taskRef) return;
  emit({
    event: 'session_start_failed',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    run_id: runId,
    task_ref: taskRef,
    agent_id: agent.agent_id,
    payload: {
      reason,
      code: 'ERR_SESSION_START_FAILED',
      working_directory: workingDirectory,
    },
  });
}

export function clearWorkerSessionRuntime(stateDir, agent, { status = 'idle' } = {}) {
  const nowIso = new Date().toISOString();
  const updates = {
    status,
    session_handle: null,
    provider_ref: null,
    last_status_change_at: nowIso,
  };
  updateAgentRuntime(stateDir, agent.agent_id, updates);
  syncAgentRuntime(agent, updates);
}

export function markWorkerOffline(stateDir, agent, { emit, reason, payload = {} }) {
  clearWorkerSessionRuntime(stateDir, agent, { status: 'offline' });
  emit({
    event: 'agent_offline',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    agent_id: agent.agent_id,
    payload: { reason, code: reasonCode(reason), ...payload },
  });
}

export async function launchWorkerSession(
  stateDir,
  agent,
  {
    adapter,
    workingDirectory,
    repoRoot = null,
    runId = null,
    taskRef = null,
    retryable = false,
    emit,
  },
) {
  try {
    const nowIso = new Date().toISOString();
    const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
      system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider, agent.role),
      model: agent.model ?? null,
      working_directory: workingDirectory,
      env: {
        ORCH_STATE_DIR: stateDir,
        ...(repoRoot ? { ORC_REPO_ROOT: repoRoot } : {}),
      },
    });
    const updates = {
      status: 'running',
      session_handle,
      provider_ref,
      last_heartbeat_at: nowIso,
      last_status_change_at: nowIso,
    };
    updateAgentRuntime(stateDir, agent.agent_id, updates);
    syncAgentRuntime(agent, updates);
    emit({
      event: 'agent_online',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: runId ?? undefined,
      task_ref: taskRef ?? undefined,
      agent_id: agent.agent_id,
      payload: {
        session_handle,
        provider_ref,
        working_directory: workingDirectory,
      },
    });
    return { ok: true, session_handle, provider_ref };
  } catch (error) {
    const reason = error?.message ?? String(error);
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
        working_directory: workingDirectory,
      },
    });
    return { ok: false, reason };
  }
}
