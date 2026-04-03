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
