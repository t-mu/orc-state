export interface ForwarderOptions {
  promptPattern?: RegExp;
  provider?: string;
  submitSequence?: string;
}

export function stripAnsi(value: unknown): string {
  return String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * No-op: PTY injection of notifications is superseded by event cursor polling
 * via the get_notifications MCP tool. The master agent polls events directly
 * instead of receiving push-injected [ORCHESTRATOR] blocks.
 */
export function startMasterPtyForwarder(
  _stateDir: string,
  _masterPty: unknown,
  _ptyDataEmitter: unknown,
  _options: ForwarderOptions = {},
): () => void {
  return (): void => {};
}
