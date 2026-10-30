#!/usr/bin/env node
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
import { readFileSync, realpathSync } from 'node:fs';
import { resolve }   from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveScript(name: string): string {
  const resolved = resolve(import.meta.dirname, name);
  if (import.meta.url.endsWith('.ts')) return resolved;
  return resolved.replace(/\.ts$/, '.js');
}

function packageJsonPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? '../package.json' : '../../package.json',
    import.meta.url,
  ));
}

export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath(), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

const COMMANDS: Record<string, string> = {
  'start-session':      'start-session.ts',
  'register-worker':    'register-worker.ts',
  'start-worker-session': 'start-worker-session.ts',
  'status':             'status.ts',
  'watch':              'watch.ts',
  'attach':             'attach.ts',
  'control-worker':     'control-worker.ts',
  'task-mark-done':     'task-mark-done.ts',
  'feature-create': 'feature-create.ts',
  'backlog-orient':     'backlog-orient.ts',
  'delegate':           'delegate-task.ts',
  'progress':           'progress.ts',
  'doctor':             'doctor.ts',
  'preflight':          'preflight.ts',
  'init':               'init.ts',
  'project':            'project.ts',
  'runs-active':        'runs-active.ts',
  'events-tail':        'events-tail.ts',
  'event-cursor':       'event-cursor.ts',
  'control':            'control.ts',
  'terminal':           'terminal.ts',
  'sessions':           'sessions.ts',
  'run-start':          'run-start.ts',
  'report-for-duty':    'report-for-duty.ts',
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
  'install':            'install.ts',
  'install-agents':     'install-agents.ts',
  'install-skills':     'install-skills.ts',
  'waiting-input':      'waiting-input.ts',
  'run-info':           'run-info.ts',
  'task-reset':         'task-reset.ts',
  'task-unblock':       'task-unblock.ts',
  'task-cancel':        'task-cancel.ts',
  'run-expire':         'run-expire.ts',
  'events-filter':      'events-filter.ts',
  'worker-status':      'worker-status.ts',
  'memory-status':      'memory-status.ts',
  'memory-search':      'memory-search.ts',
  'memory-wake-up':     'memory-wake-up.ts',
  'memory-record':      'memory-record.ts',
  'pr-diff':            'pr-diff.ts',
  'pr-review':          'pr-review.ts',
  'pr-merge':           'pr-merge.ts',
  'pr-status':          'pr-status.ts',
};

const BLESSED = [
  'start-session',
  'project',
  'status',
  'doctor',
  'preflight',
  'delegate',
  'run-start',
  'report-for-duty',
  'progress',
  'run-heartbeat',
  'run-input-request',
  'review-submit',
  'review-read',
  'run-work-complete',
  'run-finish',
  'run-fail',
  'memory-wake-up',
  'memory-record',
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
  'task-cancel',
  'task-mark-done',
  'run-expire',
  'event-cursor',
];

const INSPECTION = [
  'watch',
  'terminal',
  'runs-active',
  'sessions',
  'events-tail',
  'waiting-input',
  'run-info',
  'worker-status',
  'events-filter',
  'memory-status',
  'memory-search',
];

/** Markdown backlog tools; a registered project authors tasks with `orc project task`. */
const LEGACY_ONLY = [
  'backlog-sync',
  'backlog-sync-check',
  'backlog-orient',
  'feature-create',
];

export function buildNodeArgs(subcommand: string, scriptPath: string, rest: string[]): string[] {
  if (subcommand === 'watch' && scriptPath.endsWith('.ts')) {
    // Resolved from orc's own install: a bare `tsx/esm` would resolve from the
    // caller's cwd, which for a registered project is the target repository.
    return ['--import', import.meta.resolve('tsx/esm'), scriptPath, ...rest];
  }
  return [scriptPath, ...rest];
}

/**
 * Strip the global `--project=<id>` / `--project <id>` selector. It may come
 * before the subcommand or among its arguments, but not after a `--`
 * separator. `orc project` parses its own `--project=<id>`, so for it the
 * selector is passed through in that form.
 */
export function extractProjectSelector(argv: string[]): { argv: string[]; projectId: string | null } {
  const out: string[] = [];
  let projectId: string | null = null;
  let subcommand: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { out.push(...argv.slice(index)); break; }
    let value: string | null = null;
    if (arg === '--project') {
      value = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--project=')) {
      value = arg.slice('--project='.length);
    }
    if (value === null) {
      if (subcommand === null && !arg.startsWith('-')) subcommand = arg;
      out.push(arg);
      continue;
    }
    if (!value.trim() || value.startsWith('-')) throw new Error('--project requires a project id');
    if (subcommand === 'project') out.push(`--project=${value}`);
    else projectId = value;
  }
  return { argv: out, projectId };
}

export function main(argv: string[]): number {
  let selector: ReturnType<typeof extractProjectSelector>;
  try {
    selector = extractProjectSelector(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  const [subcommand, ...rest] = selector.argv;
  if (selector.projectId && !subcommand) {
    console.error('--project needs a subcommand, e.g. orc --project=<id> status');
    return 1;
  }

  if (subcommand === '--version' || subcommand === '-v') {
    console.log(readVersion());
    return 0;
  }

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log('Usage: orc <subcommand> [args...]');
    console.log('  --project=<id> (before or after the subcommand) selects a registered project.');
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
    console.log('\nLegacy installations only:');
    for (const name of LEGACY_ONLY) {
      console.log(`  ${name}`);
    }
    console.log('\nAdvanced / specialized commands:');
    const grouped = [...BLESSED, ...RECOVERY_DEBUG, ...INSPECTION, ...LEGACY_ONLY];
    for (const name of Object.keys(COMMANDS).filter((name) => !grouped.includes(name))) {
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

  const scriptPath = resolveScript(script);
  // `--project` is the highest-precedence selector: it becomes the child's ORC_PROJECT_ID.
  // Inherited legacy paths (a worker's ORC_STATE_DIR bridge, an operator's ORC_HOME) must not redirect it.
  const env = selector.projectId
    ? { ...process.env, ORC_PROJECT_ID: selector.projectId, ORC_STATE_DIR: '', ORC_HOME: '', ORC_REPO_ROOT: '', ORC_CONFIG_FILE: '' }
    : process.env;
  const result = spawnSync(process.execPath, buildNodeArgs(subcommand, scriptPath, rest), { stdio: 'inherit', env });
  return result.status ?? 1;
}

export function isMainModule(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (!argvEntry) {
    return false;
  }

  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
