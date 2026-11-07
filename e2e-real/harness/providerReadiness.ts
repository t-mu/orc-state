/**
 * e2e-real/harness/providerReadiness.ts
 *
 * Provider readiness gate for real-provider smoke tests.
 *
 * Readiness is defined as three binary checks only:
 *   1. binary  — the provider CLI exists on PATH
 *   2. tmux    — tmux >= 3.2 is installed (orc runs every provider session in tmux)
 *   3. spawn   — the CLI is spawnable noninteractively (exits without hanging)
 *
 * Auth is NOT checked here. If the provider fails during actual coordinator
 * startup that is a runtime failure, not a readiness failure. Conflating the
 * two gives false "auth passed" signals when only the binary is installed.
 */
import { spawnSync } from 'node:child_process';
import { stripNestedProviderEnv } from '../../lib/providerChildEnv.ts';
import { checkTmux, removeDeadTmuxSocket } from '../../adapters/tmux.ts';

export type ReadinessStage = 'binary' | 'tmux' | 'spawn';

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
 * Check stage 2: a supported tmux is installed.
 */
function checkTmuxStage(): ProviderReadinessResult {
  const tmux = checkTmux();
  return tmux.ok
    ? { ok: true, failedStage: null, message: '' }
    : { ok: false, failedStage: 'tmux', message: `tmux unavailable: ${tmux.problem}` };
}

/**
 * Check stage 3: CLI is spawnable in the way the real-provider suite uses it.
 *
 * For Codex, that means a short interactive launch in a terminal (a throwaway
 * tmux server). `codex --version` is too weak because the real failure mode
 * happens on interactive startup.
 *
 * For other providers, `<binary> --version` remains sufficient as a cheap
 * smoke check until they need a stronger probe.
 */
async function checkSpawn(provider: string): Promise<ProviderReadinessResult> {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  if (provider === 'codex') return await checkInteractiveSpawn(provider, binary, ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent']);

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

/** Starts `binary args` in a private tmux server and fails if it exits within 3 s. */
async function checkInteractiveSpawn(provider: string, binary: string, args: string[]): Promise<ProviderReadinessResult> {
  const socket = `orc-readiness-${process.pid}`;
  const tmux = (tmuxArgs: string[]) => spawnSync(process.env.ORC_TMUX_BIN ?? 'tmux', ['-L', socket, ...tmuxArgs], {
    env: stripNestedProviderEnv(process.env), encoding: 'utf8', timeout: 5000,
  });
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  try {
    const started = tmux(['set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session', '-d', '-s', 'probe', '-x', '120', '-y', '30', '-c', process.cwd(),
      [binary, ...args].map(quote).join(' ')]);
    if (started.status !== 0) {
      return { ok: false, failedStage: 'spawn', message: `Provider '${provider}': failed to start interactive probe: ${(started.stderr || '').trim()}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const state = tmux(['display-message', '-p', '-t', '=probe:', '#{pane_dead} #{pane_dead_status}']);
    const [dead, status] = (state.stdout ?? '').trim().split(' ');
    if (dead !== '0') {
      const output = tmux(['capture-pane', '-p', '-t', '=probe:']).stdout ?? '';
      return {
        ok: false,
        failedStage: 'spawn',
        message: `Provider '${provider}': interactive launch exited immediately (exitCode=${status ?? '?'}). Output tail: ${(output.slice(-4000) || '(empty)').trim()}`,
      };
    }
    return { ok: true, failedStage: null, message: '' };
  } finally {
    tmux(['kill-server']);
    removeDeadTmuxSocket(socket, { waitMs: 2000 });
  }
}

/**
 * Run all three readiness checks for a provider in order.
 * Stops at the first failure and returns a stage-specific diagnostic.
 */
export async function checkProviderReadiness(provider: string): Promise<ProviderReadinessResult> {
  const binaryResult = checkBinary(provider);
  if (!binaryResult.ok) return binaryResult;

  const tmuxResult = checkTmuxStage();
  if (!tmuxResult.ok) return tmuxResult;

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
