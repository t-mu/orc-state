import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProcessStart } from './processIdentity.ts';
import { runProjectCommand } from '../cli/project.ts';
import { listProjects } from './projectList.ts';
import { ProjectRegistry } from './projectRegistry.ts';

let temp: string;
let dataHome: string;
let registry: ProjectRegistry;

function gitRepo(name: string): string {
  const root = join(temp, name);
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  return realpathSync(root);
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'orc-project-list-'));
  dataHome = join(temp, 'data');
  registry = new ProjectRegistry(dataHome);
});

afterEach(() => {
  registry.close();
  rmSync(temp, { recursive: true, force: true });
});

describe('listProjects', () => {
  it('lists every registered project with its control socket', () => {
    const a = registry.add(gitRepo('alpha'));
    const b = registry.add(gitRepo('beta'));
    writeFileSync(join(a.stateDir, 'control.json'), JSON.stringify({ protocol_version: 1, transport: 'unix', path: '/run/alpha.sock', pid: 999999999, started_at: 'x' }));
    writeFileSync(join(b.stateDir, 'control.json'), JSON.stringify({ protocol_version: 1, transport: 'unix', path: '/run/beta.sock', pid: 999999999, started_at: 'x' }));

    const projects = listProjects({ env: { ORC_DATA_HOME: dataHome } });
    expect(projects).toEqual([
      { id: a.id, name: 'alpha', target_repo_root: a.canonicalGitRoot, state_dir: a.stateDir, control_socket: '/run/alpha.sock', coordinator_running: false },
      { id: b.id, name: 'beta', target_repo_root: b.canonicalGitRoot, state_dir: b.stateDir, control_socket: '/run/beta.sock', coordinator_running: false },
    ]);
  });

  it('lists a project whose state directory is missing without an error', () => {
    const project = registry.add(gitRepo('gone'));
    rmSync(project.stateDir, { recursive: true, force: true });
    expect(listProjects({ env: { ORC_DATA_HOME: dataHome } })).toEqual([
      { id: project.id, name: 'gone', target_repo_root: project.canonicalGitRoot, state_dir: project.stateDir, control_socket: null, coordinator_running: false },
    ]);
  });

  it('treats an unreadable control.json as no socket', () => {
    const project = registry.add(gitRepo('broken'));
    writeFileSync(join(project.stateDir, 'control.json'), '{not json');
    expect(listProjects({ env: { ORC_DATA_HOME: dataHome } })[0]).toMatchObject({ control_socket: null, coordinator_running: false });
  });

  it('reports a live coordinator found by its pid lock even without a control.json', async () => {
    const project = registry.add(gitRepo('live'));
    const script = join(temp, 'coordinator.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const coordinator = spawn(process.execPath, [script], { stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => { coordinator.once('spawn', resolve); coordinator.once('error', reject); });
      const pid = coordinator.pid!;
      writeFileSync(join(project.stateDir, 'coordinator.pid'), JSON.stringify({ pid, started_at: 'x', process_start: readProcessStart(pid) }));
      expect(listProjects({ env: { ORC_DATA_HOME: dataHome } })[0]).toMatchObject({ control_socket: null, coordinator_running: true });
    } finally {
      coordinator.kill();
    }
  });

  it('is what `orc project list --json` prints, while plain list keeps the registry records', () => {
    const project = registry.add(gitRepo('same'));
    expect(runProjectCommand(['list', '--json'], registry)).toEqual(listProjects({ env: { ORC_DATA_HOME: dataHome } }));
    expect(runProjectCommand(['list'], registry)).toEqual([project]);
    expect(() => runProjectCommand(['list', '--bogus'], registry)).toThrow('Usage');
  });
});
