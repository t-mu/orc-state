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
import { stripNestedProviderEnv } from '../../lib/providerChildEnv.ts';

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
  const pathEnv = stripNestedProviderEnv(process.env).PATH ?? '';

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
 * Check stage 3: CLI is spawnable in the way the real-provider suite uses it.
 *
 * For Codex, that means a short interactive PTY launch. `codex --version` is
 * too weak because the real failure mode happens on interactive startup.
 *
 * For other providers, `<binary> --version` remains sufficient as a cheap
 * smoke check until they need a stronger probe.
 */
async function checkSpawn(provider: string): Promise<ProviderReadinessResult> {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  if (provider === 'codex') {
    try {
      const { default: pty } = await import('node-pty');
      const env = stripNestedProviderEnv(process.env) as Record<string, string>;
      const args = ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent'];

      return await new Promise<ProviderReadinessResult>((resolve) => {
        let settled = false;
        let output = '';

        const finish = (result: ProviderReadinessResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        try {
          const proc = pty.spawn(binary, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: process.cwd(),
            env,
          });

          proc.onData((chunk) => {
            output += chunk;
            if (output.length > 4000) output = output.slice(-4000);
          });

          proc.onExit(({ exitCode, signal }) => {
            finish({
              ok: false,
              failedStage: 'spawn',
              message:
                `Provider '${provider}': interactive PTY launch exited immediately ` +
                `(exitCode=${exitCode}${signal != null ? `, signal=${signal}` : ''}). ` +
                `Output tail: ${(output || '(empty)').trim()}`,
            });
          });

          setTimeout(() => {
            try { proc.kill(); } catch { /* ignore */ }
            finish({ ok: true, failedStage: null, message: '' });
          }, 3000);
        } catch (err) {
          finish({
            ok: false,
            failedStage: 'spawn',
            message: `Provider '${provider}': failed to start interactive PTY probe: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    } catch (err) {
      return {
        ok: false,
        failedStage: 'spawn',
        message: `Provider '${provider}': failed to initialize PTY readiness probe: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const result = spawnSync(binary, ['--version'], {
      env: stripNestedProviderEnv(process.env),
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    });
    // spawnSync timeout: sets result.error (code ETIMEDOUT or ENOBUFS) and result.status = null.
    // result.signal is NOT set on timeout — only on kill signals from outside.
    if (result.error != null && result.status === null) {
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

  const spawnResult = await checkSpawn(provider);
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
