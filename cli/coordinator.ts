#!/usr/bin/env node
/**
 * cli/coordinator.ts
 * Usage: orc coordinator <start|stop|restart|status> [--json]
 *
 * Run only the project's coordinator: no master, no provider auth, no tmux
 * master check. `stop` ends the coordinator and nothing else: tasks, claims,
 * agents and worktrees are left as they are (unlike `orc kill-all`). `restart`
 * stops it and starts a new one (or just starts one when none runs).
 */
import { ACTIVE_PROJECT, assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { parseCommandArgsOrExit } from '../lib/args.ts';
import {
  describeCoordinator, restartCoordinator, startCoordinatorIfStopped, stopRunningCoordinator, type CoordinatorDescription,
} from '../lib/coordinatorProcess.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const { values, positionals } = parseCommandArgsOrExit(USAGE['coordinator'], { json: { type: 'boolean' } }, process.argv.slice(2), 1);
const json = values.json === true;
const action = positionals[0];

if (action !== 'start' && action !== 'stop' && action !== 'restart' && action !== 'status') {
  console.error(`Usage: ${USAGE['coordinator']}`);
  process.exit(1);
}

function print(result: CoordinatorDescription & { action: string; changed: boolean; previous_pid?: number | null }): void {
  if (json) return printJson(result);
  if (!result.running) return console.log(result.action === 'stop' ? 'Coordinator stopped' : 'Coordinator not running');
  const verb = !result.changed ? 'running' : result.action === 'restart' && result.previous_pid ? `restarted (was PID ${result.previous_pid})` : 'started';
  console.log(`Coordinator ${verb}  (PID ${result.pid}${result.version ? `, version ${result.version}` : ''})`);
  if (result.socket) console.log(`  socket: ${result.socket}`);
  if (result.stale) console.log(`  warning: ${result.stale}`);
}

try {
  assertProjectMode();
  if (action === 'status') {
    print({ action, changed: false, ...await describeCoordinator(STATE_DIR) });
  } else if (action === 'start') {
    const { started } = await startCoordinatorIfStopped(STATE_DIR, ACTIVE_PROJECT!.id);
    print({ action, changed: started, ...await describeCoordinator(STATE_DIR) });
  } else if (action === 'restart') {
    const { previous_pid } = await restartCoordinator(STATE_DIR, ACTIVE_PROJECT!.id);
    print({ action, changed: true, ...await describeCoordinator(STATE_DIR), previous_pid });
  } else {
    const stopped = await stopRunningCoordinator(STATE_DIR);
    print({ action, changed: stopped !== null, ...await describeCoordinator(STATE_DIR) });
  }
} catch (error) {
  await failCommand(error, json);
}
