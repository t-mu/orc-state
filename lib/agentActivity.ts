import { updateAgentRuntime } from './agentRegistry.ts';

/**
 * Record recent worker activity for operator-facing liveness views.
 * Ignore missing agents so historical/partial state does not break run reporting.
 */
export function recordAgentActivity(
  stateDir: string,
  agentId: string,
  { at = new Date().toISOString(), status = 'running' }: { at?: string; status?: string } = {},
): boolean {
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
