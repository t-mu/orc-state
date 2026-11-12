import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bridgeProjectEnv, createTempStateDir, cleanupTempStateDir, readClaims, recordMergeConfirmation } from '../test-fixtures/stateHelpers.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { closeAllDatabases, queryEvents, withEventDb } from '../lib/eventLog.ts';
import { recordProviderSession } from '../lib/runStore.ts';
import { startControlServer, type ControlServer } from '../lib/controlServer.ts';
import { credentialHash } from '../lib/sessionCredentials.ts';
import { initProjectTaskStore } from '../lib/projectTasks.ts';
import { importTaskMarkdown } from '../lib/taskMarkdown.ts';
import { tmuxSessionName, tmuxSocketName } from '../lib/tmuxNames.ts';

// Task 203 acceptance: a structured provider (Codex app-server, played by
// test-fixtures/fake-codex-app-server.ts) is claimed, ACKs the task envelope
// over its protocol, works, asks the master a question, receives the answer and
// finishes — and every coordinator → worker message is a durable command whose
// state follows the provider's turn lifecycle. The follow-up is sent through the
// coordinator's adapter (the path finalize/PR_REVIEW messages take) while the
// worker's turn is still running, so it must wait in the queue. (The real
// FINALIZE_SUCCESS notice follows the coordinator's own finishRun and is not
// delivered to an ended run; this test records the merge and has the worker finish instead.) The fake runs TURN_SCRIPT for
// each turn; the script drives the real `orc` CLI the way a worker would.

const repoRoot = resolve(import.meta.dirname, '..');
const fixtureBin = join(repoRoot, 'test-fixtures', 'bin');

const TASK_SPEC = `---
ref: project/structured-task
feature: project
---

# Task 1 — Structured task

## Goals
1. Complete the task over a structured runtime.

## Acceptance criteria
- [ ] Task completes successfully.
`;

const TURN_SCRIPT = `#!/bin/sh
set -e
orc() { "$E2E_NODE" "$E2E_ORC" "$@"; }
run_id=$(printf '%s\\n' "$FAKE_TURN_TEXT" | sed -n 's/^run_id: //p' | head -n 1)
agent_id=$(printf '%s\\n' "$FAKE_THREAD_INSTRUCTIONS" | sed -n 's/^agent_id: //p' | head -n 1)
case "$FAKE_TURN_TEXT" in
  TASK_START*)
    orc run-start --run-id="$run_id" --agent-id="$agent_id"
    orc run-input-request --run-id="$run_id" --agent-id="$agent_id" --question="Which colour?" --timeout-ms=20000 --poll-ms=50 > "$E2E_DIR/answer.txt"
    orc run-work-complete --run-id="$run_id" --agent-id="$agent_id"
    ;;
  FINALIZE_SUCCESS*)
    orc run-finish --run-id="$run_id" --agent-id="$agent_id"
    ;;
esac
`;

interface CommandRow { command_id: string; kind: string; state: string; actor_id: string; acknowledged_at: string | null }

function commands(dir: string): CommandRow[] {
  return withEventDb(dir, (db) => db.prepare('SELECT command_id, kind, state, actor_id, acknowledged_at FROM commands ORDER BY rowid').all() as CommandRow[]);
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// The master runs in orc's tmux server, so this needs tmux like the other tmux e2e tests.
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe.skipIf(!hasTmux)('structured runtime lifecycle e2e (task 203)', () => {
  let dir: string;
  let worktree: string;
  let control: ControlServer | null = null;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    dir = createTempStateDir('structured-lifecycle-e2e-');
    worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    spawnSync('git', ['init', '-q', worktree]);
    const scriptPath = join(dir, 'turn.sh');
    writeFileSync(scriptPath, TURN_SCRIPT);
    chmodSync(scriptPath, 0o755);

    Object.assign(process.env, {
      ORC_STATE_DIR: dir,
      ORC_MAX_WORKERS: '1',
      ORC_WORKER_PROVIDER: 'codex',
      ORC_WORKER_RUNTIME: 'structured',
      PATH: `${fixtureBin}:${savedEnv.PATH ?? ''}`,
      FAKE_CODEX_TURN_SCRIPT: scriptPath,
      E2E_NODE: process.execPath,
      E2E_ORC: join(repoRoot, 'cli', 'orc.ts'),
      E2E_DIR: dir,
    });
    vi.doMock('../lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn((_stateDir: string, { runId }: { runId: string }) => ({ run_id: runId, branch: `task/${runId}`, worktree_path: worktree })),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn(() => ({ worktree_path: worktree })),
    }));
  });

  afterEach(async () => {
    await control?.close();
    control = null;
    const coordinator = await import('../coordinator.ts');
    coordinator.getCoordinatorCommandDispatcher().stop();
    const adapter = coordinator.getCoordinatorAdapter('codex');
    for (const claim of readClaims(dir)) await adapter.stop(`app:${String(claim.agent_id)}`);
    spawnSync('tmux', ['-L', tmuxSocketName(dir), 'kill-server']);
    closeAllDatabases();
    vi.doUnmock('../lib/runWorktree.ts');
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    cleanupTempStateDir(dir);
  });

  it('claims, ACKs, works, asks, receives the answer and finishes through durable commands', async () => {
    initProjectTaskStore(dir);
    ensureStateInitialized(dir);
    // The project descriptor the coordinator writes on start (main()); workers launch only in a project.
    bridgeProjectEnv(dir);
    mkdirSync(join(dir, 'backlog'), { recursive: true });
    writeFileSync(join(dir, 'backlog', '001-structured-task.md'), TASK_SPEC);
    expect(importTaskMarkdown(dir, join(dir, 'backlog')).imported.map((entry) => entry.action)).toEqual(['created']);
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{
        agent_id: 'master', provider: 'claude', role: 'master',
        status: 'running', session_handle: 'tmux:master', session_token: 'master-e2e', provider_ref: null, last_heartbeat_at: null,
        registered_at: new Date().toISOString(),
      }],
    }));
    // The master runs detached in orc's tmux server: the coordinator probes it each
    // tick and retires a master whose session is gone, revoking its secret.
    const masterSession = spawnSync('tmux', ['-L', tmuxSocketName(dir), 'new-session', '-d', '-s', tmuxSessionName('master'), 'sleep 600'], { encoding: 'utf8' });
    expect(masterSession.status, masterSession.stderr).toBe(0);
    recordProviderSession(dir, {
      sessionId: 'master-e2e', runId: null, agentId: 'master', provider: 'claude',
      providerRef: null, startedAt: new Date().toISOString(), credentialHash: credentialHash('master-e2e-secret'),
    });

    const coordinator = await import('../coordinator.ts');
    // Workers report through the control API, which main() serves; here the test serves it.
    control = await startControlServer(dir, { commands: coordinator.getCoordinatorCommandDispatcher() });

    // Claim + launch on the app-server runtime; the handshake makes the session
    // ready without report-for-duty, and the envelope goes out as a durable command.
    await coordinator.tick();
    await coordinator.tick();
    const claim = await waitFor(() => readClaims(dir).find((entry) => entry.task_ref === 'project/structured-task'), 'claim');
    const runId = String(claim.run_id);
    const agentId = String(claim.agent_id);
    const envelope = await waitFor(() => commands(dir).find((command) => command.kind === 'task_envelope'), 'task envelope command');
    expect(envelope.actor_id).toBe('coordinator');
    expect(envelope.acknowledged_at).not.toBeNull();

    // The worker started the run and is blocked on a question inside its turn.
    const request = await waitFor(() => queryEvents(dir, { run_id: runId, event_type: 'input_requested' })[0], 'input request');
    expect(readClaims(dir).find((entry) => entry.run_id === runId)?.state).toBe('in_progress');
    expect(commands(dir).find((command) => command.kind === 'task_envelope')?.state).toBe('running');

    // Input for a session whose turn is running: a nudge is skipped outright and a
    // follow-up waits in the queue, unsent, until the turn ends.
    const adapter = coordinator.getCoordinatorAdapter('codex');
    await expect(adapter.send(`app:${agentId}`, `RUN_NUDGE\nrun_id: ${runId}\nRUN_NUDGE_END`)).resolves.toBe('');
    expect(commands(dir)).toHaveLength(1);
    await adapter.send(`app:${agentId}`, `FINALIZE_SUCCESS\nrun_id: ${runId}\n`);
    const held = commands(dir).find((command) => command.kind === 'coordinator_message');
    expect(held).toMatchObject({ state: 'queued', acknowledged_at: null });
    expect(queryEvents(dir, { run_id: runId, event_type: 'command_queued' }).some((event) => (event.payload as Record<string, unknown>).reason === 'recipient busy')).toBe(true);

    // The master answers with its session secret; the coordinator serving this process applies it.
    const respond = spawn(process.execPath, [join(repoRoot, 'cli', 'orc.ts'), 'run-input-respond', `--run-id=${runId}`, `--agent-id=${agentId}`, '--response=teal'], {
      env: { ...process.env, ...bridgeProjectEnv(dir), ORC_MASTER_SECRET: 'master-e2e-secret' },
    });
    let respondStderr = '';
    respond.stderr.on('data', (chunk: Buffer) => { respondStderr += chunk.toString(); });
    const [respondStatus] = await once(respond, 'close');
    expect(respondStatus, respondStderr).toBe(0);
    await waitFor(() => queryEvents(dir, { run_id: runId, event_type: 'work_complete' })[0], 'work complete');
    expect(readFileSync(join(dir, 'answer.txt'), 'utf8').trim()).toBe('teal');
    expect((request.payload as Record<string, unknown>).question).toBe('Which colour?');
    await waitFor(() => commands(dir).find((command) => command.kind === 'task_envelope' && command.state === 'completed'), 'envelope completed');

    // The coordinator records the merge before FINALIZE_SUCCESS; the worker's CLI
    // run-finish is refused until it does, so the merge is recorded first here.
    recordMergeConfirmation(dir, 'project/structured-task');

    // The dispatcher sweep delivers the held follow-up as the next turn once the
    // envelope turn has ended. (main() starts the sweep; here the test runs it.)
    const { getCoordinatorCommandDispatcher } = coordinator;
    getCoordinatorCommandDispatcher().start();
    await waitFor(() => ['done', 'released'].includes(String(readClaims(dir).find((entry) => entry.run_id === runId)?.state)) || null, 'run finished');

    const followUp = await waitFor(() => commands(dir).find((command) => command.kind === 'coordinator_message' && command.state === 'completed'), 'follow-up completed');
    expect(followUp.actor_id).toBe('coordinator');
    for (const name of ['command_accepted', 'command_running', 'command_completed']) {
      expect(queryEvents(dir, { run_id: runId, event_type: name }), name).toHaveLength(2);
    }
    expect(existsSync(join(dir, 'pty-logs', `${agentId}.log`))).toBe(true);
  }, 60_000);
});
