import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractProjectSelector } from './orc.ts';
import { codexMcpOverrideArgs } from '../lib/mcpConfig.ts';

const ORC = resolve(import.meta.dirname, 'orc.ts');
let temp: string;
let dataHome: string;

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
  return { ...env, ORC_DATA_HOME: dataHome, ORC_SESSION_TRANSPORT: 'pty', ...extra };
}

function orc(cwd: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [ORC, ...args], { cwd, env: cleanEnv(extra), encoding: 'utf8' });
}

function repo(name: string): string {
  const root = join(temp, name);
  mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-selection-')));
  dataHome = join(temp, 'data');
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('global --project selector', () => {
  it('is stripped from the arguments before or after the subcommand, but left to orc project', () => {
    expect(extractProjectSelector(['--project=a', 'status', '--json'])).toEqual({ argv: ['status', '--json'], projectId: 'a' });
    expect(extractProjectSelector(['status', '--project', 'b', '--json'])).toEqual({ argv: ['status', '--json'], projectId: 'b' });
    expect(extractProjectSelector(['project', 'show', '--project=c'])).toEqual({ argv: ['project', 'show', '--project=c'], projectId: null });
    // orc project only parses the `=` form, so the space form is normalized for it.
    expect(extractProjectSelector(['project', 'show', '--project', 'c'])).toEqual({ argv: ['project', 'show', '--project=c'], projectId: null });
    expect(extractProjectSelector(['run-fail', '--', '--project', 'x'])).toEqual({ argv: ['run-fail', '--', '--project', 'x'], projectId: null });
    expect(() => extractProjectSelector(['status', '--project='])).toThrow('requires a project id');
    expect(() => extractProjectSelector(['status', '--project', '--json'])).toThrow('requires a project id');
    expect(() => extractProjectSelector(['status', '--project'])).toThrow('requires a project id');
  });

  it('builds Codex MCP overrides that carry the project identity', () => {
    expect(codexMcpOverrideArgs('/srv/server.ts', { ORC_PROJECT_ID: 'p1', ORC_STATE_DIR: '/d/p1' }, '/bin/node')).toEqual([
      '-c', 'mcp_servers.orchestrator.command="/bin/node"',
      '-c', 'mcp_servers.orchestrator.args=["/srv/server.ts"]',
      '-c', 'mcp_servers.orchestrator.env={ORC_PROJECT_ID="p1", ORC_STATE_DIR="/d/p1"}',
    ]);
  });
});

describe('switching between registered projects', () => {
  it('shows each project its own identity and tasks without touching either repository', { timeout: 30_000 }, () => {
    const alpha = repo('alpha');
    const beta = repo('beta');
    const outside = join(temp, 'outside');
    mkdirSync(outside);
    const a = JSON.parse(orc(outside, ['project', 'add', alpha]).stdout) as { id: string };
    const b = JSON.parse(orc(outside, ['project', 'add', beta]).stdout) as { id: string };
    expect(orc(outside, ['--project', a.id, 'project', 'task', 'create', '--feature=app', '--title=Alpha work', `--project=${a.id}`]).status).toBe(0);
    expect(orc(outside, ['project', 'task', 'create', '--feature=app', '--title=Beta work', `--project=${b.id}`]).status).toBe(0);

    const alphaStatus = JSON.parse(orc(outside, ['status', '--json', `--project=${a.id}`]).stdout) as { project: { id: string; name: string } };
    expect(alphaStatus.project).toMatchObject({ id: a.id, name: 'alpha', target_repo_root: alpha });
    // Inside a registered repository the repository selects its project.
    const betaStatus = JSON.parse(orc(beta, ['status', '--json']).stdout) as { project: { id: string } };
    expect(betaStatus.project.id).toBe(b.id);
    const betaText = orc(beta, ['status']).stdout;
    expect(betaText).toContain(`project: beta (${b.id})`);

    // Outside every repository, `orc project select` switches the default.
    expect(orc(outside, ['project', 'select', a.id]).status).toBe(0);
    expect((JSON.parse(orc(outside, ['status', '--json']).stdout) as { project: { id: string } }).project.id).toBe(a.id);
    expect(orc(outside, ['project', 'select', b.id]).status).toBe(0);
    expect((JSON.parse(orc(outside, ['status', '--json']).stdout) as { project: { id: string } }).project.id).toBe(b.id);

    const doctor = orc(outside, ['doctor', '--json', `--project=${a.id}`]);
    const report = JSON.parse(doctor.stdout) as { checks: { project: { ok: boolean; project: { id: string } } } };
    expect(report.checks.project).toMatchObject({ ok: true, project: { id: a.id } });
    const preflight = JSON.parse(orc(outside, ['preflight', '--json', `--project=${b.id}`]).stdout) as { project: { id: string } };
    expect(preflight.project.id).toBe(b.id);

    for (const root of [alpha, beta]) {
      expect(readdirSync(root).sort()).toEqual(['.git', 'README.md']);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
    }
  });

  it('lets --project override an inherited state-dir bridge from another project', () => {
    const alpha = repo('alpha');
    const beta = repo('beta');
    const a = JSON.parse(orc(temp, ['project', 'add', alpha]).stdout) as { id: string; stateDir: string };
    const b = JSON.parse(orc(temp, ['project', 'add', beta]).stdout) as { id: string };
    const status = orc(temp, ['--project', b.id, 'status', '--json'], { ORC_STATE_DIR: a.stateDir, ORC_PROJECT_ID: a.id });
    expect((JSON.parse(status.stdout) as { project: { id: string } }).project.id).toBe(b.id);
    expect(orc(temp, ['--project', b.id]).status).toBe(1);
    const runs = JSON.parse(orc(beta, ['runs-active', '--json']).stdout) as { project: { id: string }; runs: unknown[] };
    expect(runs).toMatchObject({ project: { id: b.id }, runs: [] });
  });

  it('rejects an unknown --project instead of falling back to another project', () => {
    const result = orc(temp, ['status', '--project=missing']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ORC_PROJECT_ID=missing|not a registered project/);
  });
});
