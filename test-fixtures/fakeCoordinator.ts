import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A live process whose command line runs a script named coordinator.js, standing in for a coordinator. */
export interface FakeCoordinator { pid: number; child: ChildProcess; stop: () => Promise<void> }

export async function startFakeCoordinator(): Promise<FakeCoordinator> {
  const dir = mkdtempSync(join(tmpdir(), 'orc-fake-coordinator-'));
  const script = join(dir, 'coordinator.js');
  writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    pid: child.pid!,
    child,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
