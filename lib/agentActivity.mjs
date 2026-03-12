import { updateAgentRuntime } from './agentRegistry.mjs';

/**
 * Record recent worker activity for operator-facing liveness views.
 * Ignore missing agents so historical/partial state does not break run reporting.
 */
export function recordAgentActivity(stateDir, agentId, { at = new Date().toISOString(), status = 'running' } = {}) {
  try {
    updateAgentRuntime(stateDir, agentId, {
      status,
      last_heartbeat_at: at,
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Agent not found:')) {
      return false;
    }
    throw error;
  }
}
