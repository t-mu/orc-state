import { renderTemplate } from './templateRender.mjs';

/**
 * Build the bootstrap prompt for a worker session.
 * Master agents keep their existing bootstrap path; all non-master roles use
 * the task-scoped worker bootstrap contract.
 */
export function buildSessionBootstrap(agentId, provider, role) {
  const template = role === 'master' ? 'master-bootstrap-v1.txt' : 'worker-bootstrap-v2.txt';
  return renderTemplate(template, {
    agent_id: agentId,
    provider,
  });
}
