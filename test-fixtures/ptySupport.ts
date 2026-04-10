import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function probePtySupport(env = process.env) {
  const fixtureBin = fileURLToPath(new URL('./bin', import.meta.url));
  const adapterPath = fileURLToPath(new URL('../adapters/pty.ts', import.meta.url));
  const script = [
    "import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'",
    "import { tmpdir } from 'node:os'",
    "import { join } from 'node:path'",
    `const { createPtyAdapter } = await import(${JSON.stringify(adapterPath)})`,
    "const stateDir = mkdtempSync(join(tmpdir(), 'orc-pty-probe-'))",
    "process.env.ORC_STATE_DIR = stateDir",
    "const adapter = createPtyAdapter({ provider: 'claude' })",
    "let ok = false",
    "try {",
    "  await adapter.start('probe', { system_prompt: 'PING' })",
    "  const logFile = join(stateDir, 'pty-logs', 'probe.log')",
    "  await new Promise((resolve) => setTimeout(resolve, 2500))",
    "  ok = existsSync(logFile) && (() => { const log = readFileSync(logFile, 'utf8'); return log.includes('FIXTURE_READY provider=claude') && log.includes('FIXTURE_PONG'); })()",
    "} finally {",
    "  try { await adapter.stop('pty:probe'); } catch {}",
    "  rmSync(stateDir, { recursive: true, force: true })",
    "}",
    "process.exit(ok ? 0 : 1)",
  ].join(';');

  const result = spawnSync(process.execPath, ['-e', script], {
    stdio: 'ignore',
    env: {
      ...env,
      PATH: `${fixtureBin}:${env.PATH ?? ''}`,
    },
  });
  return result.status === 0;
}

export function detectPtySupport({
  strict = process.env.ORC_STRICT_PTY_TESTS === '1',
  force = process.env.ORC_PTY_AVAILABLE === '1',
  env = process.env,
  probe = probePtySupport,
} = {}) {
  if (force) return true;
  const supported = probe(env);
  if (!supported && strict) {
    throw new Error(
      'PTY support probe failed while ORC_STRICT_PTY_TESTS=1. ' +
      'This environment cannot run strict PTY integration coverage. ' +
      'If your local machine is PTY-capable but probe is flaky, run with ORC_PTY_AVAILABLE=1.',
    );
  }
  return supported;
}
