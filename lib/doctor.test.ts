import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { doctorCheckList, runDoctor, type DoctorChecks } from './doctor.ts';
import { handleDoctor } from '../mcp/handlers.ts';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { closeAllDatabases, initEventsDb } from './eventLog.ts';
import { startControlServer } from './controlServer.ts';
import { PROJECT_TASK_SCHEMA, ProjectTaskStore } from './projectTaskStore.ts';
import { RUNTIME_SCHEMA } from './runtimeSchema.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => { dir = createTempStateDir('orch-doctor-lib-test-'); });
afterEach(() => { cleanupTempStateDir(dir); });

function healthyChecks(): DoctorChecks {
  return {
    project: null,
    projectSelection: null,
    gitRepo: true,
    providerBinaries: { claude: { ok: true, binary: 'claude', package: null, detail: '' } },
    staleLinkedWorkers: [],
    orphanedActiveClaims: [],
    staleActiveClaims: [],
    lifecycleIssues: [],
    stateErrors: [],
    sandboxDependencies: { ok: true, skipped: false, missing: [] } as unknown as DoctorChecks['sandboxDependencies'],
    sandboxControlSocket: { warning: null } as DoctorChecks['sandboxControlSocket'],
    memoryHealth: { ok: true, messages: [] } as unknown as DoctorChecks['memoryHealth'],
    runtimeSchema: { ok: true, version: 1, messages: [] } as unknown as DoctorChecks['runtimeSchema'],
    coordinatorLock: { problem: null },
    coordinatorCode: { warning: null },
    coordinatorSchema: { ok: true, problems: [], coordinator: null, databases: { events: null, runtime: null } },
    tmux: { ok: true, version: '3.4', problem: null } as unknown as DoctorChecks['tmux'],
  };
}

const failing = (checks: DoctorChecks) => doctorCheckList(checks).filter((check) => !check.ok).map((check) => check.name);

describe('doctorCheckList', () => {
  it('passes every check on a healthy state', () => {
    const list = doctorCheckList(healthyChecks());
    expect(list.every((check) => check.ok)).toBe(true);
    expect(list.map((check) => check.name)).toContain('coordinator_code');
  });

  it('fails exactly the check whose condition fails, with one line of detail', () => {
    const cases: Array<[string, (checks: DoctorChecks) => void]> = [
      ['git_repo', (c) => { c.gitRepo = false; }],
      ['provider_binaries', (c) => { c.providerBinaries.codex = { ok: false, binary: 'codex', package: '@openai/codex', detail: 'Run: npm install -g @openai/codex' }; }],
      ['stale_linked_workers', (c) => { c.staleLinkedWorkers.push({ agent_id: 'w1', status: 'offline', session_handle: 'tmux:w1', note: '' }); }],
      ['orphaned_active_claims', (c) => { c.orphanedActiveClaims.push({ run_id: 'r1', task_ref: 'a/b', agent_id: 'w1', claim_state: 'claimed', owner_status: 'dead' }); }],
      ['stale_active_claims', (c) => { c.staleActiveClaims.push({ run_id: 'r1', task_ref: 'a/b', agent_id: 'w1', claim_state: 'in_progress', idle_seconds: 9000, threshold_seconds: 1200, hint: '' }); }],
      ['lifecycle_issues', (c) => { c.lifecycleIssues.push({ code: 'unknown_active_task_ref', message: 'm' } as DoctorChecks['lifecycleIssues'][number]); }],
      ['state_errors', (c) => { c.stateErrors.push('claims.json: bad\nsecond line'); }],
      ['sandbox_dependencies', (c) => { c.sandboxDependencies = { ok: false, skipped: false, missing: ['bwrap'] } as unknown as DoctorChecks['sandboxDependencies']; }],
      ['memory_health', (c) => { c.memoryHealth = { ok: false, messages: ['fts broken'] } as unknown as DoctorChecks['memoryHealth']; }],
      ['runtime_schema', (c) => { c.runtimeSchema = { ok: false, version: 0, messages: ['old'] } as unknown as DoctorChecks['runtimeSchema']; }],
      ['coordinator_lock', (c) => { c.coordinatorLock = { problem: 'stale pid file' }; }],
      ['coordinator_schema', (c) => { c.coordinatorSchema = { ...c.coordinatorSchema, ok: false, problems: ['running coordinator supports events.db schema 8'] }; }],
      ['tmux', (c) => { c.tmux = { ok: false, version: null, problem: 'tmux not found' } as unknown as DoctorChecks['tmux']; }],
      ['project_selection', (c) => { c.projectSelection = { ok: false, message: 'no project' }; }],
      ['project', (c) => { c.project = { ok: false, errors: ['layout'], warnings: [] } as unknown as DoctorChecks['project']; }],
    ];
    for (const [name, breakIt] of cases) {
      const checks = healthyChecks();
      breakIt(checks);
      expect(failing(checks), name).toEqual([name]);
      const check = doctorCheckList(checks).find((c) => c.name === name)!;
      expect(check.detail, name).not.toContain('\n');
      if (name !== 'git_repo' && name !== 'project_selection') expect(check.detail, name).not.toBe('');
    }
  });

  it('keeps the coordinator-code and control-socket warnings out of ok', () => {
    const checks = healthyChecks();
    checks.coordinatorCode = { warning: 'coordinator is running old code' };
    checks.sandboxControlSocket = { warning: 'socket outside sandbox' } as DoctorChecks['sandboxControlSocket'];
    expect(failing(checks)).toEqual([]);
    expect(doctorCheckList(checks).find((c) => c.name === 'coordinator_code')!.detail).toBe('coordinator is running old code');
  });
});

describe('runDoctor', () => {
  it('gives MCP doctor the same verdict per check as orc doctor --json', async () => {
    seedState(dir);
    // Leaves no claim to go stale between the two runs.
    const env: NodeJS.ProcessEnv = { ...process.env, ORC_STATE_DIR: dir };
    delete env.ORC_PROJECT_ID;
    const cli = spawnSync(process.execPath, ['cli/doctor.ts', '--json'], { cwd: repoRoot, env, encoding: 'utf8' });
    const cliReport = JSON.parse(cli.stdout) as { ok: boolean; checks: DoctorChecks };

    const report = await runDoctor(dir, { project: null });
    const mcp = await handleDoctor(dir);
    const verdicts = (list: Array<{ name: string; ok: boolean }>) => Object.fromEntries(list.map((c) => [c.name, c.ok]));

    expect(verdicts(doctorCheckList(report.checks))).toEqual(verdicts(doctorCheckList(cliReport.checks)));
    expect(report.ok).toBe(cliReport.ok);
    expect(cli.status).toBe(cliReport.ok ? 0 : 1);
    expect(mcp.ok).toBe(mcp.checks.every((check) => check.ok));
    expect(Object.keys(mcp).sort()).toEqual(['checks', 'ok']);
  });

  it('reports the running coordinator\'s schema range and flags a database it cannot read', async () => {
    seedState(dir);
    new ProjectTaskStore(dir).close();
    initEventsDb(dir);
    const server = await startControlServer(dir, { pollMs: 20 });
    try {
      const healthy = (await runDoctor(dir, { project: null })).checks.coordinatorSchema;
      expect(healthy).toEqual({
        ok: true, problems: [],
        coordinator: { schema_version: RUNTIME_SCHEMA.version, schemas: { events: RUNTIME_SCHEMA, runtime: PROJECT_TASK_SCHEMA } },
        databases: { events: RUNTIME_SCHEMA, runtime: PROJECT_TASK_SCHEMA },
      });

      // Newer code migrated events.db under this coordinator to a schema it cannot read.
      closeAllDatabases();
      const db = new Database(join(dir, 'events.db'));
      const future = RUNTIME_SCHEMA.version + 1;
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at, min_compatible) VALUES (?, 'future', 'now', ?)").run(future, future);
      db.pragma(`user_version = ${future}`);
      db.close();
      const report = await runDoctor(dir, { project: null });
      expect(report.checks.coordinatorSchema.ok).toBe(false);
      expect(report.checks.coordinatorSchema.databases.events).toEqual({ version: future, min_compatible: future });
      expect(doctorCheckList(report.checks).find((check) => check.name === 'coordinator_schema')).toEqual({
        name: 'coordinator_schema', ok: false,
        detail: `running coordinator supports events.db schema ${RUNTIME_SCHEMA.version}, but the database is at schema ${future} (needs code of schema ${future} or newer); run orc coordinator restart`,
      });
      expect(report.ok).toBe(false);
    } finally {
      await server.close();
      closeAllDatabases();
    }
  });
});
