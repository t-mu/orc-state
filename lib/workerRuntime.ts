import { credentialHash, newSessionSecret } from './sessionCredentials.ts';
import { updateAgentRuntime, registerAgent, removeAgent } from './agentRegistry.ts';
import { resolveOrcBin } from './orcBin.ts';
import { buildSessionBootstrap } from './sessionBootstrap.ts';
import type { Agent, AgentStatus } from '../types/agents.ts';
import type { OrcEventInput } from '../types/events.ts';
import type { ExecutionMode, ProviderName, SandboxNetwork, WorkerRuntime } from './providers.ts';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { recordProviderSession } from './runStore.ts';
import { readProjectDescriptor } from './projectContext.ts';
import { defaultSocketPath } from './controlProtocol.ts';
import { SESSION_OWNER_TTL_MS, currentSessionOwnerId, type SupervisedSession } from './sessionSupervisor.ts';
import { beginSessionResume, completeSessionResume } from './sessionResume.ts';
import type { WorkerBootstrapProfile } from './sessionBootstrap.ts';

function syncAgentRuntime(agent: Agent, updates: Partial<Agent>): void {
  Object.assign(agent, updates);
}

function withPrependedPath(pathValue: string | undefined, entry: string): string {
  const segments = (pathValue ?? '').split(delimiter).filter(Boolean);
  if (segments.includes(entry)) return pathValue ?? entry;
  return [entry, ...segments].join(delimiter);
}

export function normalizeWorkerEnv(
  baseEnv: NodeJS.ProcessEnv,
  repoRoot: string | null = null,
  project: { id: string; stateDir: string; sessionId?: string; sessionSecret?: string } | null = null,
): Record<string, string> {
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
  if (project) {
    // The worker finds its state through the project identity and talks to
    // the coordinator over the local control endpoint.
    env.ORC_PROJECT_ID = project.id;
    // The state-dir bridge: a sandboxed worker resolves its project from this directory's descriptor without opening the registry.
    env.ORC_STATE_DIR = project.stateDir;
    env.ORC_CONTROL_SOCKET = defaultSocketPath(project.stateDir);
    // The session id names the session (report-for-duty); its secret, held only in this
    // environment, is the credential every control call presents (task 231). A master
    // secret, and the legacy ORC_SESSION_TOKEN name for the id, inherited from the
    // coordinator's environment are blanked.
    if (project.sessionId) env.ORC_SESSION_ID = project.sessionId;
    env.ORC_SESSION_TOKEN = '';
    if (project.sessionSecret) env.ORC_SESSION_SECRET = project.sessionSecret;
    env.ORC_MASTER_SECRET = '';
  }
  // Prevent interactive editors, pagers, and merge-tool prompts from blocking
  // headless sessions. Workers never need an interactive editor.
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
    /** Absent on a resume: the provider conversation already holds the bootstrap. */
    system_prompt?: string;
    /** Claude: the `--session-id` of a new conversation. */
    conversation_id?: string;
    /** Claude `--resume` / Codex `thread/resume` target. */
    resume_conversation_id?: string;
    model: string | null;
    working_directory: string | null | undefined;
    read_only?: boolean;
    require_git_checkout?: boolean;
    execution_mode?: 'full-access' | 'sandbox';
    sandbox_network?: SandboxNetwork;
    startup_profile?: 'default' | 'real-provider-smoke';
    runtime?: WorkerRuntime;
    env: Record<string, string>;
  }): Promise<{ session_handle: string; provider_ref: unknown }>;
  stop(sessionHandle: string): Promise<void>;
}

function resolveWorkerBootstrapProfile(env: NodeJS.ProcessEnv = process.env): WorkerBootstrapProfile {
  return env.ORC_WORKER_BOOTSTRAP_PROFILE === 'smoke' ? 'smoke' : 'default';
}

function resolveWorkerStartupProfile(env: NodeJS.ProcessEnv = process.env): 'default' | 'real-provider-smoke' {
  return env.ORC_WORKER_STARTUP_PROFILE === 'real-provider-smoke' ? 'real-provider-smoke' : 'default';
}

function stripWorkerProfileControlEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  delete next.ORC_WORKER_BOOTSTRAP_PROFILE;
  delete next.ORC_WORKER_STARTUP_PROFILE;
  return next;
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
    executionMode,
    sandboxNetwork,
    runtime,
    emit,
    sessionId = randomUUID(),
  }: {
    adapter: Adapter;
    workingDirectory: string | null | undefined;
    repoRoot?: string | null;
    runId?: string | null;
    taskRef?: string | null;
    taskModel?: string | null;
    executionMode?: ExecutionMode;
    sandboxNetwork?: SandboxNetwork;
    runtime?: WorkerRuntime;
    emit: (event: OrcEventInput) => void;
    sessionId?: string;
  },
): Promise<{ ok: boolean; session_handle?: string; provider_ref?: unknown; reason?: string }> {
  try {
    const nowIso = new Date().toISOString();
    const effectiveMode: ExecutionMode = agent.role === 'scout' ? 'sandbox' : (executionMode ?? 'full-access');
    // The coordinator writes its project's descriptor on start; a session never launches outside a project.
    const project = readProjectDescriptor(stateDir);
    if (!project) throw new Error(`Not a registered project's state directory (no project descriptor): ${stateDir}`);
    const sessionSecret = newSessionSecret();
    const workerEnv = stripWorkerProfileControlEnv(normalizeWorkerEnv({
      ORC_STATE_DIR: stateDir,
    }, repoRoot, { id: project.id, stateDir, sessionId, sessionSecret }));
    const workerBootstrapProfile = resolveWorkerBootstrapProfile();
    const workerStartupProfile = resolveWorkerStartupProfile();
    // orc chooses the Claude conversation id so a crashed session can be resumed (`--resume`).
    const conversationId = agent.provider === 'claude' ? randomUUID() : null;
    const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
      ...(conversationId ? { conversation_id: conversationId } : {}),
      system_prompt: buildSessionBootstrap(
        agent.agent_id,
        agent.provider,
        agent.role ?? 'worker',
        workerEnv.ORC_BIN ?? 'orc',
        sessionId,
        { workerBootstrapProfile },
      ),
      model: taskModel ?? agent.model ?? null,
      working_directory: workingDirectory ?? undefined,
      read_only: agent.role === 'scout',
      require_git_checkout: agent.role === 'worker',
      execution_mode: effectiveMode,
      ...(sandboxNetwork ? { sandbox_network: sandboxNetwork } : {}),
      startup_profile: workerStartupProfile,
      // Scouts stay on the CLI; only task workers use a structured runtime.
      ...(runtime && agent.role !== 'scout' ? { runtime } : {}),
      env: workerEnv,
    });
    // A structured runtime proves readiness with its protocol handshake; the
    // provider never runs a turn before input, so it cannot report for duty.
    const protocolReady = (provider_ref as { protocol_ready?: unknown } | null)?.protocol_ready === true;
    const updates: Partial<Agent> = {
      status: 'running',
      session_handle,
      session_token: sessionId,
      session_started_at: nowIso,
      session_ready_at: protocolReady ? nowIso : null,
      provider_ref: provider_ref as Agent['provider_ref'],
      last_heartbeat_at: nowIso,
      last_status_change_at: nowIso,
    };
    const ref = (provider_ref ?? {}) as { transport?: unknown; pid?: unknown; process_start?: unknown; thread_id?: unknown };
    const recorded = recordProviderSession(stateDir, {
      sessionId,
      runId,
      agentId: agent.agent_id,
      provider: agent.provider,
      providerRef: provider_ref,
      startedAt: nowIso,
      transport: typeof ref.transport === 'string' ? ref.transport : null,
      processPid: typeof ref.pid === 'number' ? ref.pid : null,
      processStart: typeof ref.process_start === 'string' ? ref.process_start : null,
      ownerId: currentSessionOwnerId(),
      ownerExpiresAt: new Date(Date.now() + SESSION_OWNER_TTL_MS).toISOString(),
      credentialHash: credentialHash(sessionSecret),
      providerConversationId: conversationId ?? (typeof ref.thread_id === 'string' ? ref.thread_id : null),
    });
    if (!recorded) {
      // The run is gone (cancelled during the launch): no row means no credential, so the session must not live on.
      try { await adapter.stop(session_handle); } catch { /* best effort: the launch fails either way */ }
      throw new Error(`run ${runId} no longer exists; stopped the session started for it`);
    }
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

/**
 * Relaunch a task worker whose session process crashed, in place: same
 * `session_id`, worktree, environment, settings and MCP isolation, resuming
 * its provider conversation. The secret rotates before the launch (the old one
 * is rejected from then on) and the bootstrap is not resent as a message (a
 * Codex thread gets it back as developer instructions); the caller sends the
 * continue nudge. On failure nothing is cleaned up: the caller requeues.
 */
export async function resumeWorkerSession(
  stateDir: string,
  agent: Agent,
  session: SupervisedSession,
  {
    adapter,
    workingDirectory,
    repoRoot = null,
    taskModel = null,
    executionMode,
    sandboxNetwork,
    reason,
  }: {
    adapter: Adapter;
    workingDirectory: string;
    repoRoot?: string | null;
    taskModel?: string | null;
    executionMode?: ExecutionMode;
    sandboxNetwork?: SandboxNetwork;
    reason: string;
  },
): Promise<{ ok: true; generation: number } | { ok: false; generation: number; reason: string }> {
  const sessionSecret = newSessionSecret();
  const begun = beginSessionResume(stateDir, session.session_id, credentialHash(sessionSecret));
  if (!begun) return { ok: false, generation: session.generation, reason: 'session record not found' };
  try {
    const project = readProjectDescriptor(stateDir);
    if (!project) throw new Error(`Not a registered project's state directory (no project descriptor): ${stateDir}`);
    const workerEnv = stripWorkerProfileControlEnv(normalizeWorkerEnv({
      ORC_STATE_DIR: stateDir,
    }, repoRoot, { id: project.id, stateDir, sessionId: session.session_id, sessionSecret }));
    const structured = session.transport === 'app-server';
    const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
      ...(session.provider_conversation_id ? { resume_conversation_id: session.provider_conversation_id } : {}),
      // A Codex thread takes the bootstrap as developer instructions (thread config, not a message);
      // `thread/resume` is given them again rather than relying on the thread keeping them.
      ...(structured ? {
        system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider, agent.role ?? 'worker', workerEnv.ORC_BIN ?? 'orc',
          session.session_id, { workerBootstrapProfile: resolveWorkerBootstrapProfile() }),
      } : {}),
      model: taskModel ?? agent.model ?? null,
      working_directory: workingDirectory,
      read_only: false,
      require_git_checkout: true,
      execution_mode: executionMode ?? 'full-access',
      ...(sandboxNetwork ? { sandbox_network: sandboxNetwork } : {}),
      startup_profile: resolveWorkerStartupProfile(),
      // The resumed session keeps its runtime: an `app:` session resumes its thread on the structured runtime.
      ...(structured ? { runtime: 'structured' as WorkerRuntime } : {}),
      env: workerEnv,
    });
    const nowIso = new Date().toISOString();
    const ref = (provider_ref ?? {}) as { transport?: unknown; pid?: unknown; process_start?: unknown; thread_id?: unknown; protocol_ready?: unknown };
    completeSessionResume(stateDir, session, {
      generation: begun.generation,
      providerRef: provider_ref,
      transport: typeof ref.transport === 'string' ? ref.transport : null,
      processPid: typeof ref.pid === 'number' ? ref.pid : null,
      processStart: typeof ref.process_start === 'string' ? ref.process_start : null,
      ownerId: currentSessionOwnerId(),
      ownerExpiresAt: new Date(Date.now() + SESSION_OWNER_TTL_MS).toISOString(),
      conversationId: typeof ref.thread_id === 'string' ? ref.thread_id : null,
      reason,
    });
    // A session that had reported for duty is still ready: the resumed conversation carries it.
    const wasReady = agent.session_ready_at != null;
    const updates: Partial<Agent> = {
      status: 'running',
      session_handle,
      session_token: session.session_id,
      session_started_at: nowIso,
      session_ready_at: wasReady || ref.protocol_ready === true ? nowIso : null,
      provider_ref: provider_ref as Agent['provider_ref'],
      last_heartbeat_at: nowIso,
      last_status_change_at: nowIso,
    };
    updateAgentRuntime(stateDir, agent.agent_id, updates);
    syncAgentRuntime(agent, updates);
    return { ok: true, generation: begun.generation };
  } catch (error) {
    return { ok: false, generation: begun.generation, reason: (error as Error)?.message ?? String(error) };
  }
}

/**
 * Register a fresh ephemeral worker agent and launch its session.
 *
 * Ephemeral workers are task-scoped: they are registered with ephemeral=true
 * and exist only for the duration of one run. The coordinator removes their
 * registry entry on terminal cleanup (success or failure).
 *
 * On registration failure, returns `{ ok: false }`.
 * On session launch failure, the partially-registered agent is removed before
 * returning so no stranded registry entry is left behind.
 */
export async function spawnEphemeralWorker(
  stateDir: string,
  {
    agentId,
    provider,
    adapter,
    workingDirectory,
    repoRoot = null,
    runId = null,
    taskRef = null,
    taskModel = null,
    executionMode,
    sandboxNetwork,
    runtime,
    emit,
    sessionId = randomUUID(),
  }: {
    agentId: string;
    provider: ProviderName;
    adapter: Adapter;
    workingDirectory: string | null | undefined;
    repoRoot?: string | null;
    runId?: string | null;
    taskRef?: string | null;
    taskModel?: string | null;
    executionMode?: ExecutionMode;
    sandboxNetwork?: SandboxNetwork;
    runtime?: WorkerRuntime;
    emit: (event: OrcEventInput) => void;
    sessionId?: string;
  },
): Promise<{ ok: boolean; agent?: Agent; session_handle?: string; provider_ref?: unknown; reason?: string }> {
  let agent: Agent;
  try {
    agent = registerAgent(stateDir, { agent_id: agentId, provider, role: 'worker', ephemeral: true });
  } catch (error) {
    return { ok: false, reason: `agent registration failed: ${(error as Error).message}` };
  }

  const result = await launchWorkerSession(stateDir, agent, {
    adapter,
    workingDirectory,
    repoRoot,
    runId,
    taskRef,
    taskModel,
    ...(executionMode !== undefined ? { executionMode } : {}),
    ...(sandboxNetwork !== undefined ? { sandboxNetwork } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
    emit,
    sessionId,
  });

  if (!result.ok) {
    // Remove the agent we just registered — no stranded registry entries
    try { removeAgent(stateDir, agentId); } catch { /* ignore */ }
    return { ok: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
  }

  return {
    ok: true,
    agent,
    ...(result.session_handle !== undefined ? { session_handle: result.session_handle } : {}),
    provider_ref: result.provider_ref,
  };
}
