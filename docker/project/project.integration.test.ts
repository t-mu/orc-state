import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const composeFile = join(import.meta.dirname, 'compose.yml');
const enabled = process.env.ORC_DOCKER_SMOKE === '1';

describe.runIf(enabled)('project container Docker smoke', () => {
  it('keeps mounts and login/state data across recreation without publishing a port', () => {
    const project = mkdtempSync(join(tmpdir(), 'orc-docker-project-'));
    const composeName = `orcsmoke${process.pid}`;
    const override = join(project, 'smoke-compose.yml');
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
    const compose = (...args: string[]) => run('docker', ['compose', '--project-name', composeName,
      '-f', composeFile, '-f', override, ...args]);
    try {
      run('git', ['init', project]);
      mkdirSync(join(project, '.orc-state'));
      writeFileSync(override, 'services:\n  project:\n    entrypoint: ["sleep", "600"]\n');
      compose('build');
      compose('up', '-d', '--no-build');
      const write = `test "$(id -u)" = '${env.ORC_UID}' && test -w /workspace/project && test ! -e /var/run/docker.sock && test ! -e /root/.ssh && printf login > /home/node/login-marker && sqlite3 /workspace/project/.orc-state/persist.db 'CREATE TABLE smoke (value INTEGER); INSERT INTO smoke VALUES (42);' && printf worktree > /workspace/project/worktree-marker`;
      compose('exec', '-T', 'project', 'bash', '-lc', write);
      compose('down');
      compose('up', '-d', '--no-build');
      compose('exec', '-T', 'project', 'bash', '-lc',
        'test "$(cat /home/node/login-marker)" = login && test "$(sqlite3 /workspace/project/.orc-state/persist.db "SELECT value FROM smoke;")" = 42 && test "$(cat /workspace/project/worktree-marker)" = worktree');

      const containerId = compose('ps', '-q', 'project');
      const inspect = JSON.parse(run('docker', ['inspect', containerId]))[0] as {
        HostConfig: { Privileged: boolean };
        NetworkSettings: { Ports: Record<string, unknown> };
        Mounts: Array<{ Destination: string; Source: string }>;
      };
      expect(inspect.HostConfig.Privileged).toBe(false);
      expect(Object.values(inspect.NetworkSettings.Ports ?? {}).every((port) => port == null)).toBe(true);
      expect(inspect.Mounts.map((mount) => mount.Destination).sort()).toEqual([
        '/home/node', '/workspace/project', '/workspace/project/.orc-state',
      ]);
      expect(JSON.stringify(inspect.Mounts)).not.toContain('docker.sock');
      const workers = compose('exec', '-T', 'project', 'node', '/opt/orc-state/docker/project/smoke-workers.ts');
      expect(workers).toContain('two-provider-workers');
    } finally {
      try { compose('down', '--volumes', '--remove-orphans'); } catch { /* build may have failed */ }
      rmSync(project, { recursive: true, force: true });
    }
  }, 900_000);
});
