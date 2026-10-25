import { renderTemplate } from './templateRender.ts';
import { isSupportedProvider, type ProviderName } from './providers.ts';
import { IS_SIBLING_LAYOUT, STATE_DIR } from './paths.ts';
import { isProjectStateDir } from './projectTasks.ts';

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
 * {{phase_complete_step}}. Mode-aware: in the attached layout the worker edits
 * the task spec to `status: done` (carried by the merge); in the sibling layout
 * the coordinator writes the spec back after merge (task 187), so the worker
 * must NOT edit the spec and must never commit framework files into the target
 * repo. Built with orc_bin/agent_id already interpolated because the outer
 * renderTemplate makes a single pass and will not re-expand placeholders inside
 * an injected value.
 */
function phaseCompleteStep(orcBin: string, agentId: string, sibling: boolean, project = false): string {
  if (project) {
    return [
      '  7. Signal complete phase. Task status lives in project SQLite and the coordinator records `done` after merge — there is no task spec file to edit:',
      `       ${orcBin} progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=${agentId}`,
      '       - Do NOT create or edit any task spec or `status:` field; commit ONLY product code',
      `       - Do not call \`${orcBin} task-mark-done\` from the worker session`,
    ].join('\n');
  }
  if (sibling) {
    return [
      '  7. Signal complete phase. In this sibling layout the coordinator records completion after merge — do NOT edit the task spec:',
      `       ${orcBin} progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=${agentId}`,
      '       - Do NOT edit the task spec `status:` field; the coordinator writes `status: done` back into the orchestration backlog after merge',
      '       - Commit ONLY product code. Never commit framework files (task specs, plans, .orc-state, or other orchestration artifacts) into the target repo',
      `       - Do not call \`${orcBin} task-mark-done\` from the worker session`,
    ].join('\n');
  }
  return [
    '  7. Signal complete phase and update the task markdown in this assigned worktree to `status: done`:',
    `       ${orcBin} progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=${agentId}`,
    '       - Edit the task spec file referenced by `task_spec_worktree_path` (the pinned `task_spec_path` is read-only)',
    '       - Change its frontmatter `status:` field to `done`',
    `       - Do not call \`${orcBin} task-mark-done\` from the worker session; the coordinator marks shared runtime state done after merge`,
  ].join('\n');
}

function renderBootstrap(template: string, provider: string, agentId: string): string {
  return renderTemplate(template, {
    agent_id: agentId,
    orc_bin: 'orc',
    provider,
    session_token: 'session-token-unset',
    phase_complete_step: phaseCompleteStep('orc', agentId, IS_SIBLING_LAYOUT, isProjectStateDir(STATE_DIR)),
  });
}

export type WorkerBootstrapProfile = 'default' | 'smoke';

// The smoke profile keeps its own hardcoded attached-mode Phase 4 step (it also
// folds the spec edit into the task commit). It is a deterministic lifecycle
// smoke-test fixture run in the attached layout, not a production or sibling
// path — sibling-mode smoke is out of scope (the sibling e2e lives in task 192).
// It has no {{phase_complete_step}} placeholder, so the injected var is simply
// unused for this profile.
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
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string, sessionToken: string, options: { workerBootstrapProfile?: WorkerBootstrapProfile; siblingLayout?: boolean; projectState?: boolean }): string;
export function buildSessionBootstrap(
  agentId: string,
  provider: string,
  role: string,
  orcBin: string = 'orc',
  sessionToken: string = 'session-token-unset',
  options: { workerBootstrapProfile?: WorkerBootstrapProfile; siblingLayout?: boolean; projectState?: boolean } = {},
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
  const sibling = options.siblingLayout ?? IS_SIBLING_LAYOUT;
  return renderTemplate(resolveWorkerTemplate(role, options.workerBootstrapProfile ?? 'default'), {
    agent_id: agentId,
    orc_bin: orcBin,
    provider,
    session_token: sessionToken,
    phase_complete_step: phaseCompleteStep(orcBin, agentId, sibling, options.projectState ?? isProjectStateDir(STATE_DIR)),
  });
}
