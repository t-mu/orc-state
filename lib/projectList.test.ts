import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProcessStart } from './processIdentity.ts';
import { runProjectCommand } from '../cli/project.ts';
import Database from 'better-sqlite3';
import { listProjects, RegistrySchemaError } from './projectList.ts';
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
  it('lists every registered project and drops the socket of a stopped coordinator', () => {
    const a = registry.add(gitRepo('alpha'));
    const b = registry.add(gitRepo('beta'));
    writeFileSync(join(a.stateDir, 'control.json'), JSON.stringify({ protocol_version: 1, transport: 'unix', path: '/run/alpha.sock', pid: 999999999, started_at: 'x' }));
    writeFileSync(join(b.stateDir, 'control.json'), JSON.stringify({ protocol_version: 1, transport: 'unix', path: '/run/beta.sock', pid: 999999999, started_at: 'x' }));

    const projects = listProjects({ env: { ORC_DATA_HOME: dataHome } });
    expect(projects).toEqual([
      { id: a.id, name: 'alpha', target_repo_root: a.canonicalGitRoot, state_dir: a.stateDir, repo_present: true, control_socket: null, coordinator_running: false },
      { id: b.id, name: 'beta', target_repo_root: b.canonicalGitRoot, state_dir: b.stateDir, repo_present: true, control_socket: null, coordinator_running: false },
    ]);
  });

  it('lists a project whose state directory is missing without an error', () => {
    const project = registry.add(gitRepo('gone'));
    rmSync(project.stateDir, { recursive: true, force: true });
    expect(listProjects({ env: { ORC_DATA_HOME: dataHome } })).toEqual([
      { id: project.id, name: 'gone', target_repo_root: project.canonicalGitRoot, state_dir: project.stateDir, repo_present: true, control_socket: null, coordinator_running: false },
    ]);
  });

  it('reports repo_present false when the checkout is gone', () => {
    const root = gitRepo('moved');
    registry.add(root);
    rmSync(root, { recursive: true, force: true });
    expect(listProjects({ env: { ORC_DATA_HOME: dataHome } })[0]).toMatchObject({ repo_present: false });
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
      writeFileSync(join(project.stateDir, 'control.json'), JSON.stringify({ protocol_version: 1, transport: 'unix', path: '/run/live.sock', pid, started_at: 'x' }));
      expect(listProjects({ env: { ORC_DATA_HOME: dataHome } })[0]).toMatchObject({ control_socket: '/run/live.sock', coordinator_running: true });
    } finally {
      coordinator.kill();
    }
  });

  it('returns [] for an empty data home and creates nothing', () => {
    const empty = join(temp, 'empty');
    expect(listProjects({ env: { ORC_DATA_HOME: empty } })).toEqual([]);
    expect(existsSync(empty)).toBe(false);
    mkdirSync(empty);
    expect(listProjects({ env: { ORC_DATA_HOME: empty } })).toEqual([]);
    expect(readdirSync(empty)).toEqual([]);
  });

  it('reads the registry without running DDL or migrations', () => {
    const bare = join(temp, 'bare');
    mkdirSync(bare);
    new Database(join(bare, 'registry.db')).close();
    expect(listProjects({ env: { ORC_DATA_HOME: bare } })).toEqual([]);
    const db = new Database(join(bare, 'registry.db'));
    try {
      expect(db.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);
      expect(db.pragma('user_version', { simple: true })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('reads a WAL registry with no writer open, adding nothing but its WAL files', () => {
    const project = registry.add(gitRepo('wal'));
    registry.close();
    expect(listProjects({ env: { ORC_DATA_HOME: dataHome } })).toMatchObject([{ id: project.id, name: 'wal' }]);
    expect(readdirSync(dataHome).filter((name) => !['registry.db', 'registry.db-shm', 'registry.db-wal', 'projects'].includes(name))).toEqual([]);
    registry = new ProjectRegistry(dataHome);
    expect(registry.list()).toEqual([project]);
  });

  it('throws a typed error for a newer registry schema', () => {
    const newer = join(temp, 'newer');
    mkdirSync(newer);
    const db = new Database(join(newer, 'registry.db'));
    db.pragma('user_version = 2');
    db.close();
    let error: unknown;
    try { listProjects({ env: { ORC_DATA_HOME: newer } }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RegistrySchemaError);
    expect(error).toMatchObject({ version: 2, supportedVersion: 1 });
  });

  it('is what `orc project list --json` prints, while plain list keeps the registry records', () => {
    const project = registry.add(gitRepo('same'));
    expect(runProjectCommand(['list', '--json'], registry)).toEqual(listProjects({ env: { ORC_DATA_HOME: dataHome } }));
    expect(runProjectCommand(['list'], registry)).toEqual([project]);
    expect(() => runProjectCommand(['list', '--bogus'], registry)).toThrow('Usage');
  });
});
