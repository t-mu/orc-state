#!/usr/bin/env -S node --experimental-strip-types
/**
 * cli/orc.ts
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

const COMMANDS: Record<string, string> = {
  'start-session':      'start-session.ts',
  'register-worker':    'register-worker.ts',
  'start-worker-session': 'start-worker-session.ts',
  'status':             'status.ts',
  'watch':              'watch.ts',
  'attach':             'attach.ts',
  'control-worker':     'control-worker.ts',
  'task-create':        'task-create.ts',
  'feature-create': 'feature-create.ts',
  'backlog-orient':     'backlog-orient.ts',
  'delegate':           'delegate-task.ts',
  'progress':           'progress.ts',
  'doctor':             'doctor.ts',
  'preflight':          'preflight.ts',
  'init':               'init.ts',
  'runs-active':        'runs-active.ts',
  'events-tail':        'events-tail.ts',
  'run-start':          'run-start.ts',
  'run-input-request':  'run-input-request.ts',
  'run-input-respond':  'run-input-respond.ts',
  'run-heartbeat':      'run-heartbeat.ts',
  'run-work-complete':  'run-work-complete.ts',
  'run-finish':         'run-finish.ts',
  'run-fail':           'run-fail.ts',
  'deregister':         'deregister.ts',
  'worker-remove':      'remove-worker.ts',
  'worker-gc':          'gc-workers.ts',
  'worker-clearall':    'clear-workers.ts',
  'kill-all':           'kill-all.ts',
  'mcp-server':         'mcp-server.ts',
  'backlog-sync':       'backlog-sync.ts',
  'backlog-sync-check': 'backlog-sync-check.ts',
  'install-skills':     'install-skills.ts',
  'waiting-input':      'waiting-input.ts',
  'run-info':           'run-info.ts',
  'task-reset':         'task-reset.ts',
  'task-unblock':       'task-unblock.ts',
  'run-expire':         'run-expire.ts',
  'events-filter':      'events-filter.ts',
  'worker-status':      'worker-status.ts',
  'backlog-ready':      'backlog-ready.ts',
  'backlog-blocked':    'backlog-blocked.ts',
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
const result = spawnSync(process.execPath, ['--experimental-strip-types', scriptPath, ...rest], { stdio: 'inherit' });
process.exit(result.status ?? 1);
