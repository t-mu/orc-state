import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { initEventsDb, withEventDbTransaction } from '../lib/eventLog.ts';
import { startControlServer } from '../lib/controlServer.ts';
import { credentialHash } from '../lib/sessionCredentials.ts';
import { readClaims } from '../lib/stateReader.ts';
import { bridgeProjectEnv } from './stateHelpers.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

export interface CliResult { status: number | null; stdout: string; stderr: string }

/**
 * The environment a CLI child runs `dir` in as a registered project: no
 * inherited ORC_* variable (a worker session's own secret or socket must never
 * reach a test), the project bridge, and no retry window for a missing
 * coordinator.
 */
export function projectCliEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
  return { ...base, ORC_DATA_HOME: '/nonexistent/orc-test-data-home', ORC_CONTROL_RETRY_MS: '0', ...bridgeProjectEnv(dir), ...extra };
}

/** Run an operator CLI (no coordinator is running, so it applies its mutation directly). */
export function runProjectCli(dir: string, script: string, args: string[] = [], extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('node', [resolve(REPO_ROOT, script), ...args], { cwd: REPO_ROOT, env: projectCliEnv(dir, extra), encoding: 'utf8' });
}

function flagValue(args: string[], name: string): string | null {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/**
 * Register the running worker session a lifecycle CLI presents, the way the
 * coordinator records one at launch, and return its secret. The session is
 * scoped to `runId` and named `sessionId` (report-for-duty presents its own id).
 */
export function recordWorkerSession(dir: string, agentId: string, runId: string, sessionId = `session-${agentId}-${runId}`): string {
  const secret = `secret-${sessionId}`;
  initEventsDb(dir);
  readClaims(dir);
  withEventDbTransaction(dir, (db) => {
    // A run no claim names (a test of an unknown run id) gets a bare row, which is no claim, to scope the session to.
    db.prepare(`INSERT OR IGNORE INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at)
      VALUES (?, 'test/session', ?, 'claimed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(runId, agentId);
    db.prepare(`INSERT OR IGNORE INTO sessions
      (session_id, run_id, agent_id, provider, state, started_at, updated_at, credential_hash)
      VALUES (?, ?, ?, 'claude', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`)
      .run(sessionId, runId, agentId, credentialHash(secret));
  });
  return secret;
}

/**
 * Answer as the coordinator for a worker session: register the session of
 * `agentId` scoped to `runId` and start a control server applying lifecycle
 * requests to `dir`. `env` runs a CLI child as that session; the child must
 * run asynchronously so this process can answer it.
 */
export async function openWorkerSession(dir: string, agentId: string, runId: string, sessionId?: string): Promise<{ env: NodeJS.ProcessEnv; close: () => Promise<void> }> {
  const secret = recordWorkerSession(dir, agentId, runId, sessionId);
  const server = await startControlServer(dir, { pollMs: 20 });
  return { env: projectCliEnv(dir, { ORC_SESSION_SECRET: secret }), close: () => server.close() };
}

/**
 * Run a worker lifecycle CLI as the worker session named by its --agent-id
 * and --run-id (and --session-id, unless `sessionId` names the session that
 * really runs), against a control server applying it to `dir` as the
 * coordinator would.
 */
export async function runWorkerCli(dir: string, script: string, args: string[] = [], extra: Record<string, string> = {},
  { sessionId = flagValue(args, 'session-id') ?? flagValue(args, 'session-token') ?? undefined }: { sessionId?: string } = {}): Promise<CliResult> {
  const session = await openWorkerSession(dir, flagValue(args, 'agent-id') ?? 'worker-unknown', flagValue(args, 'run-id') ?? 'run-session', sessionId);
  try {
    return await new Promise<CliResult>((done, fail) => {
      const child = spawn('node', [resolve(REPO_ROOT, 'cli', script), ...args], { cwd: REPO_ROOT, env: { ...session.env, ...extra }, timeout: 20_000 });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', fail);
      child.on('close', (status) => done({ status, stdout, stderr }));
    });
  } finally {
    await session.close();
  }
}

/** Register the running master session `agentId` (its agents.json entry must have role master) and return its secret. */
export function recordMasterSession(dir: string, agentId = 'master'): string {
  const secret = `secret-session-${agentId}`;
  initEventsDb(dir);
  withEventDbTransaction(dir, (db) => db.prepare(`INSERT OR IGNORE INTO sessions
    (session_id, run_id, agent_id, provider, state, started_at, updated_at, credential_hash)
    VALUES (?, NULL, ?, 'claude', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`)
    .run(`session-${agentId}`, agentId, credentialHash(secret)));
  return secret;
}
