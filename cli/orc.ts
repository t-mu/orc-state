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
  'task-mark-done':     'task-mark-done.ts',
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
  'review-submit':      'review-submit.ts',
  'review-read':        'review-read.ts',
  'deregister':         'deregister.ts',
  'worker-remove':      'remove-worker.ts',
  'worker-gc':          'gc-workers.ts',
  'worker-clearall':    'clear-workers.ts',
  'kill-all':           'kill-all.ts',
  'mcp-server':         'mcp-server.ts',
  'backlog-sync':       'backlog-sync.ts',
  'backlog-sync-check': 'backlog-sync-check.ts',
  'install-agents':     'install-agents.ts',
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

const BLESSED = [
  'start-session',
  'status',
  'doctor',
  'preflight',
  'task-create',
  'task-mark-done',
  'backlog-sync',
  'backlog-sync-check',
  'delegate',
  'run-start',
  'run-heartbeat',
  'run-work-complete',
  'run-finish',
  'run-fail',
];

const RECOVERY_DEBUG = [
  'register-worker',
  'start-worker-session',
  'attach',
  'control-worker',
  'deregister',
  'worker-remove',
  'worker-gc',
  'worker-clearall',
  'kill-all',
  'task-reset',
  'task-unblock',
  'run-expire',
];

const INSPECTION = [
  'watch',
  'runs-active',
  'events-tail',
  'waiting-input',
  'run-info',
  'worker-status',
  'events-filter',
  'backlog-ready',
  'backlog-blocked',
];

export function buildNodeArgs(subcommand: string, scriptPath: string, rest: string[]): string[] {
  if (subcommand === 'watch') {
    return ['--import', 'tsx/esm', scriptPath, ...rest];
  }
  return ['--experimental-strip-types', scriptPath, ...rest];
}

export function main(argv: string[]): number {
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: orc <subcommand> [args...]');
    console.log('\nBlessed workflow commands:');
    for (const name of BLESSED) {
      console.log(`  ${name}`);
    }
    console.log('\nRecovery / debug commands:');
    for (const name of RECOVERY_DEBUG) {
      console.log(`  ${name}`);
    }
    console.log('\nSupported inspection commands:');
    for (const name of INSPECTION) {
      console.log(`  ${name}`);
    }
    console.log('\nAdvanced / specialized commands:');
    for (const name of Object.keys(COMMANDS).filter((name) => !BLESSED.includes(name) && !RECOVERY_DEBUG.includes(name) && !INSPECTION.includes(name))) {
      console.log(`  ${name}`);
    }
    return 0;
  }

  const script = COMMANDS[subcommand];
  if (!script) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Run "orc --help" to see available subcommands.');
    return 1;
  }

  const scriptPath = resolve(import.meta.dirname, script);
  const result = spawnSync(process.execPath, buildNodeArgs(subcommand, scriptPath, rest), { stdio: 'inherit' });
  return result.status ?? 1;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  process.exit(main(process.argv.slice(2)));
}
