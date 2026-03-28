import { renderTemplate } from './templateRender.ts';
import { isSupportedProvider, type ProviderName } from './providers.ts';

const WORKER_BOOTSTRAP_TEMPLATE = 'worker-bootstrap-v2.txt';
const SCOUT_BOOTSTRAP_TEMPLATE = 'scout-bootstrap-v1.txt';

const MASTER_BOOTSTRAP_TEMPLATES: Record<ProviderName, string> = {
  claude: 'master-bootstrap-v1.txt',
  codex: 'master-bootstrap-codex-v1.txt',
  gemini: 'master-bootstrap-gemini-v1.txt',
};

function assertProvider(provider: string): ProviderName {
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported bootstrap provider: ${provider}`);
  }
  return provider;
}

function renderBootstrap(template: string, provider: string, agentId: string): string {
  return renderTemplate(template, {
    agent_id: agentId,
    orc_bin: 'orc',
    provider,
  });
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
  return renderBootstrap(MASTER_BOOTSTRAP_TEMPLATES[resolvedProvider], resolvedProvider, agentId);
}

/**
 * Build the bootstrap prompt for a worker session.
 * Master agents keep their existing bootstrap path; all non-master roles use
 * the task-scoped worker bootstrap contract.
 */
export function buildSessionBootstrap(agentId: string, provider: string, role: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string = 'orc'): string {
  if (role === 'master') return getMasterBootstrap(provider, agentId);
  if (role === 'scout') return getScoutBootstrap(provider, agentId);
  return renderTemplate(WORKER_BOOTSTRAP_TEMPLATE, {
    agent_id: agentId,
    orc_bin: orcBin,
    provider,
  });
}
