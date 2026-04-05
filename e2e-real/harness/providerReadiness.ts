/**
 * e2e-real/harness/providerReadiness.ts
 *
 * Provider readiness gate for real-provider smoke tests.
 *
 * Readiness is defined as three binary checks only:
 *   1. binary  — the provider CLI exists on PATH
 *   2. pty     — node-pty can be loaded (PTY support available)
 *   3. spawn   — the CLI is spawnable noninteractively (exits without hanging)
 *
 * Auth is NOT checked here. If the provider fails during actual coordinator
 * startup that is a runtime failure, not a readiness failure. Conflating the
 * two gives false "auth passed" signals when only the binary is installed.
 */
import { spawnSync } from 'node:child_process';

export type ReadinessStage = 'binary' | 'pty' | 'spawn';

export interface ProviderReadinessResult {
  /** Whether the provider passed all readiness checks. */
  ok: boolean;
  /** The stage at which the check failed, or null if all passed. */
  failedStage: ReadinessStage | null;
  /** Human-readable diagnostic for the failure (empty string if ok). */
  message: string;
}

const PROVIDER_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

/**
 * Check stage 1: provider binary exists on PATH.
 */
function checkBinary(provider: string): ProviderReadinessResult {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  const pathEnv = process.env.PATH ?? '';

  try {
    const result = spawnSync('which', [binary], {
      env: { PATH: pathEnv },
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      return { ok: true, failedStage: null, message: '' };
    }
  } catch {
    // fall through to failure
  }

  return {
    ok: false,
    failedStage: 'binary',
    message: `Provider '${provider}': binary '${binary}' not found on PATH. Install it and re-run.`,
  };
}

/**
 * Check stage 2: node-pty is loadable.
 */
async function checkPty(): Promise<ProviderReadinessResult> {
  try {
    await import('node-pty');
    return { ok: true, failedStage: null, message: '' };
  } catch (err) {
    return {
      ok: false,
      failedStage: 'pty',
      message: `PTY support unavailable: node-pty could not be loaded. Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check stage 3: CLI is spawnable noninteractively.
 * We call `<binary> --version` with a strict timeout. The process must exit
 * without hanging — we do not care about exit code or output content.
 */
function checkSpawn(provider: string): ProviderReadinessResult {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    });
    // If the process timed out, signal is 'SIGTERM' and status is null
    if (result.signal === 'SIGTERM' || result.error?.message?.includes('TIMEDOUT')) {
      return {
        ok: false,
        failedStage: 'spawn',
        message: `Provider '${provider}': CLI '${binary} --version' timed out after 5s. The binary may require interactive auth to start.`,
      };
    }
    // Any exit (even non-zero) counts as spawnable — we just need it to exit
    return { ok: true, failedStage: null, message: '' };
  } catch (err) {
    return {
      ok: false,
      failedStage: 'spawn',
      message: `Provider '${provider}': failed to spawn '${binary} --version': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run all three readiness checks for a provider in order.
 * Stops at the first failure and returns a stage-specific diagnostic.
 */
export async function checkProviderReadiness(provider: string): Promise<ProviderReadinessResult> {
  const binaryResult = checkBinary(provider);
  if (!binaryResult.ok) return binaryResult;

  const ptyResult = await checkPty();
  if (!ptyResult.ok) return ptyResult;

  const spawnResult = checkSpawn(provider);
  if (!spawnResult.ok) return spawnResult;

  return { ok: true, failedStage: null, message: '' };
}

/**
 * Convenience: skip a test when the provider is not ready.
 * Returns the readiness result so callers can log the message.
 */
export async function requireProviderReady(provider: string): Promise<ProviderReadinessResult> {
  return checkProviderReadiness(provider);
}
