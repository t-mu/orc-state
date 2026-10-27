/**
 * lib/sandboxDeps.ts
 *
 * Checks for sandbox-required OS dependencies (bwrap, socat) on Linux
 * when a Claude provider role is configured with execution_mode === 'sandbox'.
 * macOS uses Seatbelt (built-in), so the check is skipped there.
 * Codex sandbox does not use bwrap/socat, so the check is also skipped for Codex.
 */
import { isBinaryAvailable } from './binaryCheck.ts';
import { loadMasterConfig, loadWorkerPoolConfig } from './providers.ts';

function safeLoad<T>(load: () => T): T | null {
  try {
    return load();
  } catch {
    return null;
  }
}

export function checkSandboxDependencies({
  platform = process.platform,
  env = process.env,
  configFile,
}: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
} = {}): { ok: boolean; skipped: boolean; reason: string; missing: string[] } {
  const masterOpts = configFile !== undefined ? { env, configFile } : { env };
  const workerOpts = configFile !== undefined ? { env, configFile } : { env };
  const masterConfig = safeLoad(() => loadMasterConfig(masterOpts));
  const workerConfig = safeLoad(() => loadWorkerPoolConfig(workerOpts));

  const claudeMasterSandbox = masterConfig?.provider === 'claude' && masterConfig.execution_mode === 'sandbox';
  const claudeWorkerSandbox = workerConfig?.provider === 'claude' && workerConfig.execution_mode === 'sandbox';

  if (!claudeMasterSandbox && !claudeWorkerSandbox) {
    return { ok: true, skipped: true, reason: 'no Claude sandbox configured', missing: [] };
  }

  if (platform !== 'linux') {
    return { ok: true, skipped: true, reason: 'non-Linux platform (Seatbelt built-in)', missing: [] };
  }

  const missing: string[] = [];
  if (!isBinaryAvailable('bwrap')) missing.push('bwrap');
  if (!isBinaryAvailable('socat')) missing.push('socat');

  return { ok: missing.length === 0, skipped: false, reason: '', missing };
}

/**
 * A sandboxed project worker reaches its coordinator only through the control
 * socket (task 230). Only Claude's macOS sandbox allows that one socket by
 * path; Codex and Claude on Linux connect only with the opt-in
 * `worker_pool.sandbox_network: open`. Without it, their lifecycle commands
 * fail, so doctor warns.
 */
export function checkSandboxControlSocket({
  platform = process.platform,
  env = process.env,
  configFile,
  project,
}: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
  project: boolean;
}): { warning: string | null } {
  if (!project) return { warning: null };
  const workerConfig = safeLoad(() => loadWorkerPoolConfig(configFile !== undefined ? { env, configFile } : { env }));
  if (workerConfig?.execution_mode !== 'sandbox' || workerConfig.sandbox_network === 'open') return { warning: null };
  if (workerConfig.provider !== 'codex' && !(workerConfig.provider === 'claude' && platform === 'linux')) return { warning: null };
  const sandbox = workerConfig.provider === 'codex' ? 'the Codex sandbox' : "Claude's Linux sandbox";
  return {
    warning: `sandboxed ${workerConfig.provider} workers (the default worker provider; a task's required_provider is not checked) cannot reach the coordinator's `
      + `control socket under ${sandbox}, so their lifecycle commands fail; `
      + 'set worker_pool.sandbox_network to open (it widens the sandbox network, see docs/configuration.md → Execution Modes) or use full-access',
  };
}
