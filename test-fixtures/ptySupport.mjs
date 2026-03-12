import { spawnSync } from 'node:child_process';

function probePtySupport(env = process.env) {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/c', 'exit 0'] : ['-lc', 'exit 0'];
  const script = [
    "import pty from 'node-pty'",
    `const proc = pty.spawn(${JSON.stringify(shell)}, ${JSON.stringify(args)}, { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })`,
    "setTimeout(() => process.exit(0), 50)",
  ].join(';');

  const result = spawnSync(process.execPath, ['-e', script], {
    stdio: 'ignore',
    env,
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
