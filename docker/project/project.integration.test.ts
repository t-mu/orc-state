import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const composeFile = join(import.meta.dirname, 'compose.yml');
const enabled = process.env.ORC_DOCKER_SMOKE === '1';

describe.runIf(enabled)('project container Docker smoke', () => {
  it('keeps mounts and login/state data across recreation without publishing a port', () => {
    const project = mkdtempSync(join(tmpdir(), 'orc-docker-project-'));
    const composeName = `orcsmoke${process.pid}`;
    const env = {
      ...process.env,
      ORC_PROJECT_DIR: project,
      ORC_UID: String(process.getuid?.() ?? 1000),
      ORC_GID: String(process.getgid?.() ?? 1000),
      ORC_PROJECT_IMAGE: `orc-project-smoke:${process.pid}`,
    };
    const run = (binary: string, args: string[]) => execFileSync(binary, args, {
      cwd: project, env, encoding: 'utf8', timeout: 600_000,
    }).trim();
    const compose = (...args: string[]) => run('docker', ['compose', '--project-name', composeName, '-f', composeFile, ...args]);
    let containerId = '';
    try {
      run('git', ['init', project]);
      mkdirSync(join(project, '.orc-state'));
      compose('build');
      const write = `test "$(id -u)" = '${env.ORC_UID}' && test -w /workspace/project && test ! -e /var/run/docker.sock && test ! -e /root/.ssh && printf login > /home/node/login-marker && printf sqlite > /workspace/project/.orc-state/state-marker && printf worktree > /workspace/project/worktree-marker`;
      compose('run', '--rm', '--no-deps', '--entrypoint', 'bash', 'project', '-lc', write);
      compose('run', '--rm', '--no-deps', '--entrypoint', 'bash', 'project', '-lc',
        'test "$(cat /home/node/login-marker)" = login && test "$(cat /workspace/project/.orc-state/state-marker)" = sqlite && test "$(cat /workspace/project/worktree-marker)" = worktree');

      containerId = compose('run', '-d', '--no-deps', '--entrypoint', 'sleep', 'project', '120');
      const inspect = JSON.parse(run('docker', ['inspect', containerId]))[0] as {
        HostConfig: { PortBindings: Record<string, unknown> | null; Privileged: boolean; Binds: string[] | null };
        NetworkSettings: { Ports: Record<string, unknown> };
      };
      expect(inspect.HostConfig.Privileged).toBe(false);
      expect(Object.values(inspect.NetworkSettings.Ports ?? {}).every((port) => port == null)).toBe(true);
      expect(JSON.stringify(inspect.HostConfig.Binds ?? [])).not.toContain('docker.sock');
      const processes = run('docker', ['exec', containerId, 'bash', '-lc', 'sleep 15 & a=$!; sleep 15 & b=$!; kill -0 "$a" && kill -0 "$b"; kill "$a" "$b"; echo two-processes']);
      expect(processes).toContain('two-processes');
    } finally {
      if (containerId) {
        try { run('docker', ['rm', '-f', containerId]); } catch { /* already stopped */ }
      }
      try { compose('down', '--volumes', '--remove-orphans'); } catch { /* build may have failed */ }
      rmSync(project, { recursive: true, force: true });
    }
  }, 900_000);
});
