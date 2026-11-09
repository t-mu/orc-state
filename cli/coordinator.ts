#!/usr/bin/env node
/**
 * cli/coordinator.ts
 * Usage: orc coordinator <start|stop|status> [--json]
 *
 * Run only the project's coordinator: no master, no provider auth, no tmux
 * master check. `stop` ends the coordinator and nothing else: tasks, claims,
 * agents and worktrees are left as they are (unlike `orc kill-all`).
 */
import { ACTIVE_PROJECT, assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { ControlClient, controlSocketFromEnv } from '../lib/controlClient.ts';
import { ControlError, defaultSocketPath } from '../lib/controlProtocol.ts';
import { staleCodeWarning } from '../lib/codeIdentity.ts';
import { coordinatorStatus, spawnCoordinator, stopCoordinator } from '../lib/coordinatorProcess.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const { values, positionals } = parseCommandArgsOrExit(USAGE['coordinator'], { json: { type: 'boolean' } }, process.argv.slice(2), 1);
const json = values.json === true;
const action = positionals[0];

if (action !== 'start' && action !== 'stop' && action !== 'status') {
  console.error(`Usage: ${USAGE['coordinator']}`);
  process.exit(1);
}

/** What `status` and the other actions report. `version` and `stale` come from the running coordinator's control API, when it answers. */
async function describe(): Promise<{
  running: boolean; pid: number | null; version: string | null; socket: string | null; started_at: string | null; stale: string | null;
}> {
  const { running, pid } = coordinatorStatus(STATE_DIR);
  if (!running) return { running, pid: null, version: null, socket: null, started_at: null, stale: null };
  const socket = controlSocketFromEnv() ?? defaultSocketPath(STATE_DIR);
  try {
    const health = await new ControlClient(STATE_DIR, { timeoutMs: 3_000, socketPath: controlSocketFromEnv() }).health();
    return { running, pid, version: health.version, socket, started_at: health.started_at, stale: staleCodeWarning(health) };
  } catch {
    // Starting up, or a coordinator that predates /v1/health: the pid is still true.
    return { running, pid, version: null, socket, started_at: null, stale: null };
  }
}

function print(result: Awaited<ReturnType<typeof describe>> & { action: string; changed: boolean }): void {
  if (json) return printJson(result);
  if (!result.running) return console.log(result.action === 'stop' ? 'Coordinator stopped' : 'Coordinator not running');
  console.log(`Coordinator ${result.action === 'start' && result.changed ? 'started' : 'running'}  (PID ${result.pid}${result.version ? `, version ${result.version}` : ''})`);
  if (result.socket) console.log(`  socket: ${result.socket}`);
  if (result.stale) console.log(`  warning: ${result.stale}`);
}

try {
  assertProjectMode();
  if (action === 'status') {
    print({ action, changed: false, ...await describe() });
  } else if (action === 'start') {
    const before = coordinatorStatus(STATE_DIR);
    if (before.running) {
      print({ action, changed: false, ...await describe() });
    } else {
      ensureStateInitialized(STATE_DIR);
      const pid = await spawnCoordinator(STATE_DIR, ACTIVE_PROJECT!.id);
      if (pid === null) throw new ControlError('unavailable', 'coordinator did not write its pid lock within 2 s; check orc status, then retry', 503);
      print({ action, changed: true, ...await describe() });
    }
  } else {
    const { running, pid } = coordinatorStatus(STATE_DIR);
    if (running && pid !== null && !await stopCoordinator(STATE_DIR, pid)) {
      throw new ControlError('unavailable', `coordinator PID ${pid} is still running; retry, or use orc kill-all`, 503);
    }
    print({ action, changed: running, ...await describe() });
  }
} catch (error) {
  await failCommand(error, json);
}
