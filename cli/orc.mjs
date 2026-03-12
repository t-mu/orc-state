#!/usr/bin/env node
/**
 * cli/orc.mjs
 * Dispatcher: orc <subcommand> [args...]
 *
 * Examples:
 *   orc start-session
 *   orc start-session --provider=claude
 *   orc register-worker worker-01 --provider=claude
 *   orc watch
 */
import { spawnSync } from 'node:child_process';
import { resolve }   from 'node:path';

const COMMANDS = {
  'start-session':      'start-session.mjs',
  'register-worker':    'register-worker.mjs',
  'start-worker-session': 'start-worker-session.mjs',
  'status':             'status.mjs',
  'watch':              'watch.mjs',
  'attach':             'attach.mjs',
  'control-worker':     'control-worker.mjs',
  'task-create':        'task-create.mjs',
  'delegate':           'delegate-task.mjs',
  'progress':           'progress.mjs',
  'doctor':             'doctor.mjs',
  'preflight':          'preflight.mjs',
  'init':               'init.mjs',
  'runs-active':        'runs-active.mjs',
  'events-tail':        'events-tail.mjs',
  'run-start':          'run-start.mjs',
  'run-input-request':  'run-input-request.mjs',
  'run-input-respond':  'run-input-respond.mjs',
  'run-heartbeat':      'run-heartbeat.mjs',
  'run-work-complete':  'run-work-complete.mjs',
  'run-finish':         'run-finish.mjs',
  'run-fail':           'run-fail.mjs',
  'deregister':         'deregister.mjs',
  'worker-remove':      'remove-worker.mjs',
  'worker-gc':          'gc-workers.mjs',
  'worker-clearall':    'clear-workers.mjs',
  'kill-all':           'kill-all.mjs',
  'mcp-server':         'mcp-server.mjs',
  'backlog-sync-check': 'backlog-sync-check.mjs',
  'install-skills':     'install-skills.mjs',
};

const [subcommand, ...rest] = process.argv.slice(2);

if (!subcommand || subcommand === '--help' || subcommand === '-h') {
  console.log('Usage: orc <subcommand> [args...]');
  console.log('\nAvailable subcommands:');
  for (const name of Object.keys(COMMANDS)) {
    console.log(`  ${name}`);
  }
  process.exit(0);
}

const script = COMMANDS[subcommand];
if (!script) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Run "orc --help" to see available subcommands.`);
  process.exit(1);
}

const scriptPath = resolve(import.meta.dirname, script);
const result = spawnSync(process.execPath, [scriptPath, ...rest], { stdio: 'inherit' });
process.exit(result.status ?? 1);
