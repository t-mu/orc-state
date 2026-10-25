import { renderTemplate } from './templateRender.ts';
import { isSupportedProvider, type ProviderName } from './providers.ts';

const WORKER_BOOTSTRAP_TEMPLATE = 'worker-bootstrap-v2.txt';
const WORKER_BOOTSTRAP_SMOKE_TEMPLATE = 'worker-bootstrap-smoke-v1.txt';
const SCOUT_BOOTSTRAP_TEMPLATE = 'scout-bootstrap-v1.txt';

const MASTER_BOOTSTRAP_TEMPLATE = 'master-bootstrap-v1.txt';

function assertProvider(provider: string): ProviderName {
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported bootstrap provider: ${provider}`);
  }
  return provider;
}

/**
 * Phase-4 "complete" step text, injected into the worker bootstrap as
 * {{phase_complete_step}}. Task status is runtime-owned in every layout: the
 * coordinator records `done` after merge, and no task spec mirrors it, so the
 * worker never edits a `status:` field. Built with orc_bin/agent_id already
 * interpolated because the outer renderTemplate makes a single pass and will
 * not re-expand placeholders inside an injected value.
 */
function phaseCompleteStep(orcBin: string, agentId: string): string {
  return [
    '  7. Signal complete phase. Task status is runtime-owned — the coordinator records `done` after merge:',
    `       ${orcBin} progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=${agentId}`,
    '       - Do NOT edit the `status:` field of any task spec; commit only the changes the task asks for, never orchestration state',
    `       - Do not call \`${orcBin} task-mark-done\` from the worker session`,
  ].join('\n');
}

function renderBootstrap(template: string, provider: string, agentId: string): string {
  return renderTemplate(template, {
    agent_id: agentId,
    orc_bin: 'orc',
    provider,
    session_token: 'session-token-unset',
    phase_complete_step: phaseCompleteStep('orc', agentId),
  });
}

export type WorkerBootstrapProfile = 'default' | 'smoke';

// The smoke profile keeps its own hardcoded Phase 4 step. It is a deterministic
// lifecycle smoke-test fixture, not a production path. It has no
// {{phase_complete_step}} placeholder, so the injected var is simply unused for
// this profile.
function resolveWorkerTemplate(role: string, workerBootstrapProfile: WorkerBootstrapProfile = 'default'): string {
  if (role === 'worker' && workerBootstrapProfile === 'smoke') {
    return WORKER_BOOTSTRAP_SMOKE_TEMPLATE;
  }
  return WORKER_BOOTSTRAP_TEMPLATE;
}

export function getWorkerBootstrap(provider: string): string;
export function getWorkerBootstrap(provider: string, agentId: string): string;
export function getWorkerBootstrap(provider: string, agentId: string = 'worker'): string {
  const resolvedProvider = assertProvider(provider);
  return renderBootstrap(WORKER_BOOTSTRAP_TEMPLATE, resolvedProvider, agentId);
}

export function getScoutBootstrap(provider: string): string;
export function getScoutBootstrap(provider: string, agentId: string): string;
export function getScoutBootstrap(provider: string, agentId: string = 'scout'): string {
  const resolvedProvider = assertProvider(provider);
  return renderBootstrap(SCOUT_BOOTSTRAP_TEMPLATE, resolvedProvider, agentId);
}

export function getMasterBootstrap(provider: string): string;
export function getMasterBootstrap(provider: string, agentId: string): string;
export function getMasterBootstrap(provider: string, agentId: string = 'master'): string {
  const resolvedProvider = assertProvider(provider);
  return renderBootstrap(MASTER_BOOTSTRAP_TEMPLATE, resolvedProvider, agentId);
}

/**
 * Build the bootstrap prompt for a worker session.
 * Master agents keep their existing bootstrap path; all non-master roles use
 * the task-scoped worker bootstrap contract.
 */
export function buildSessionBootstrap(agentId: string, provider: string, role: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string, sessionToken: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string, sessionToken: string, options: { workerBootstrapProfile?: WorkerBootstrapProfile }): string;
export function buildSessionBootstrap(
  agentId: string,
  provider: string,
  role: string,
  orcBin: string = 'orc',
  sessionToken: string = 'session-token-unset',
  options: { workerBootstrapProfile?: WorkerBootstrapProfile } = {},
): string {
  if (role === 'master') return getMasterBootstrap(provider, agentId);
  if (role === 'scout') {
    return renderTemplate(SCOUT_BOOTSTRAP_TEMPLATE, {
      agent_id: agentId,
      orc_bin: orcBin,
      provider,
      session_token: sessionToken,
    });
  }
  return renderTemplate(resolveWorkerTemplate(role, options.workerBootstrapProfile ?? 'default'), {
    agent_id: agentId,
    orc_bin: orcBin,
    provider,
    session_token: sessionToken,
    phase_complete_step: phaseCompleteStep(orcBin, agentId),
  });
}
