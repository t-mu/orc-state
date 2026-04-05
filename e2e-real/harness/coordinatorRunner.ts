/**
 * e2e-real/harness/coordinatorRunner.ts
 *
 * Start and stop the real coordinator process against a temp repo.
 *
 * The coordinator is launched as a child process with all runtime paths pinned
 * into the temp repo via the RuntimeEnv helper. stdout and stderr are captured
 * for failure diagnostics.
 *
 * Lifecycle:
 *   const runner = await startCoordinator(env, { timeoutMs: 10_000 });
 *   // ... run assertions ...
 *   await runner.stop();
 */
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeEnv } from './runtimeEnv.ts';

const REAL_REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const COORDINATOR_PATH = resolve(REAL_REPO_ROOT, 'coordinator.ts');

export interface CoordinatorStartOptions {
  /**
   * How long to wait for the coordinator to produce its first tick output
   * before treating it as a startup failure (ms). Default: 15_000.
   */
  startupTimeoutMs?: number;
  /**
   * Coordinator tick interval (ms). Use a short interval in tests so lifecycle
   * transitions happen quickly. Default: 5_000.
   */
  tickIntervalMs?: number;
  /**
   * Override the coordinator script path. Used in tests to inject a stub
   * that exits immediately, exercising the startup-failure diagnostic path.
   * Default: coordinator.ts in the real repo root.
   */
  coordinatorPath?: string;
}

export interface CoordinatorRunner {
  /** The underlying child process. Use for advanced signal/wait needs. */
  process: ChildProcess;
  /** Captured stdout text so far. */
  stdout(): string;
  /** Captured stderr text so far. */
  stderr(): string;
  /** Gracefully stop the coordinator and wait for the process to exit. */
  stop(timeoutMs?: number): Promise<void>;
}

/**
 * Spawn the real coordinator against the temp repo described by `runtimeEnv`.
 *
 * The coordinator is started with `--mode=autonomous` and a short tick interval
 * so it dispatches quickly during tests.
 */
export async function startCoordinator(
  runtimeEnv: RuntimeEnv,
  options: CoordinatorStartOptions = {},
): Promise<CoordinatorRunner> {
  const { startupTimeoutMs = 15_000, tickIntervalMs = 5_000, coordinatorPath = COORDINATOR_PATH } = options;

  const args = [
    '--experimental-strip-types',
    coordinatorPath,
    '--mode=autonomous',
    `--interval-ms=${tickIntervalMs}`,
  ];

  const proc = spawn('node', args, {
    cwd: runtimeEnv.cwd,
    env: runtimeEnv.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString(); });
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

  // Wait for the process to produce any output (first tick signal) or fail early
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `[coordinatorRunner] startup timeout (${startupTimeoutMs}ms) — coordinator produced no output.\n` +
        `stdout: ${stdoutBuf.slice(-500) || '(empty)'}\n` +
        `stderr: ${stderrBuf.slice(-500) || '(empty)'}`,
      ));
    }, startupTimeoutMs);

    const onData = () => { clearTimeout(timer); resolve(); };
    const onError = (err: Error) => { clearTimeout(timer); reject(err); };
    const onClose = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(
        `[coordinatorRunner] process exited during startup with code ${code}.\n` +
        `stdout: ${stdoutBuf.slice(-500) || '(empty)'}\n` +
        `stderr: ${stderrBuf.slice(-500) || '(empty)'}`,
      ));
    };

    proc.stdout?.once('data', onData);
    proc.stderr?.once('data', onData);
    proc.once('error', onError);
    proc.once('close', onClose);
  });

  async function stop(shutdownTimeoutMs = 10_000): Promise<void> {
    if (proc.killed || proc.exitCode !== null) return;

    proc.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Force kill if graceful shutdown timed out
        if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL');
        resolve();
      }, shutdownTimeoutMs);

      proc.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  return {
    process: proc,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    stop,
  };
}
