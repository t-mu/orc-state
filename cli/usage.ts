/**
 * cli/usage.ts
 * One usage synopsis per `orc` subcommand. The dispatcher prints it for
 * `orc <subcommand> --help` (or `-h`) instead of running the command, so
 * asking a state-changing command for help can never execute it.
 */
export const USAGE: Record<string, string> = {
  'start-session':     'orc start-session [--provider=<claude|codex|gemini>] [--agent-id=<id>]',
  'status':            'orc status [--json [--events=<0-200>]] [--mine --agent-id=<id>] [--watch|-w [--interval-ms=<ms>] [--once]]',
  'watch':             'orc watch [--interval-ms=<ms>] [--once]',
  'attach':            'orc attach <agent_id|run_id> [--write]',
  'task-mark-done':    'orc task-mark-done <task_ref> [--actor-id=<id>]',
  'delegate':          'orc delegate --task-ref=<feature/task> [--target-agent-id=<id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<id>]',
  'progress':          'orc progress --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--note=<text>] [--policy=<requeue|block>]',
  'doctor':            'orc doctor [--json] [--stale-progress-ms=<ms>] [--stale-start-ms=<ms>]',
  'preflight':         'orc preflight [--json]',
  'init':              'orc init [--provider=claude,codex,gemini] [--worker-provider=<name>]',
  'project':           'orc project add <git-path> [--name=N] | list [--json] | select <id> | show | config <list|get|set|unset> [key] [value] [--global] | task <list [--status=<s>[,<s>]] [--feature=<f>]|show|revisions|create|edit|import|export> [ref|path] | plan <list|show|import|export> [id|path]   (all accept --project=<id>)',
  'runs-active':       'orc runs-active [--json] [--via-control]',
  'events-tail':       'orc events-tail [--n=<count>] [--event=<name>] [--json]',
  'event-cursor':      'orc event-cursor [--consumer=<id>] [--reset-to=<seq>]   (reset requires a stopped coordinator)',
  'control':           'orc control snapshot | events [--after=<seq>] [--limit=<n>] [--follow] [--max-events=<n>] | command ... | ack <command_id> --state=<state> | message ... | messages ... | consume <message_id>',
  'terminal':          'orc terminal <provider|shell> <run_id> [--write] [--once]',
  'sessions':          'orc sessions [--all] [--json]',
  'run-start':         'orc run-start --run-id=<id> --agent-id=<id>',
  'report-for-duty':   'orc report-for-duty --agent-id=<id> --session-id=<id>',
  'run-input-request': 'orc run-input-request --run-id=<id> --agent-id=<id> --question=<text> [--timeout-ms=<ms>] [--poll-ms=<ms>]',
  'run-input-respond': 'orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>]',
  'run-heartbeat':     'orc run-heartbeat   (deprecated no-op: leases renew automatically)',
  'run-work-complete': 'orc run-work-complete --run-id=<id> --agent-id=<id>',
  'run-finish':        'orc run-finish --run-id=<id> --agent-id=<id>',
  'run-fail':          'orc run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--code=<code>] [--policy=<requeue|block>]',
  'review-submit':     'orc review-submit --run-id=<id> --agent-id=<worker_id> --outcome=<approved|findings> --reason=<text> [--reviewer=<label>]',
  'review-read':       'orc review-read --run-id=<id> [--json]',
  'worker-remove':     'orc worker-remove <worker_id> [--keep-session]',
  'worker-gc':         'orc worker-gc',
  'kill-all':          'orc kill-all [--keep-sessions]   (stops the coordinator, resets active tasks, removes run worktrees)',
  'mcp-server':        'orc mcp-server   (stdio MCP server; started by orc start-session)',
  'install':           'orc install [--provider=claude,codex,gemini] [--global] [--dry-run] [--skip-skills] [--skip-agents]',
  'install-agents':    'orc install-agents [--provider=claude,codex,gemini] [--global] [--dry-run]',
  'install-skills':    'orc install-skills [--provider=claude,codex,gemini] [--global] [--dry-run]',
  'waiting-input':     'orc waiting-input [--json]',
  'run-info':          'orc run-info <run_id> [--json]',
  'task-reset':        'orc task-reset <task_ref> [--actor-id=<id>]',
  'task-unblock':      'orc task-unblock <task_ref> [--reason=<text>] [--actor-id=<id>]',
  'task-cancel':       'orc task-cancel <task_ref> [--reason=<text>] [--actor-id=<id>]',
  'run-expire':        'orc run-expire <run_id>',
  'run-close':         'orc run-close <run_id> [--reason=<text>] [--actor-id=<id>]',
  'events-filter':     'orc events-filter [--run-id=<id>] [--agent-id=<id>] [--event=<type>] [--last=<N>] [--json]',
  'worker-status':     'orc worker-status [<agent_id>] [--json]',
  'memory-status':     'orc memory-status',
  'memory-search':     'orc memory-search <query> [--wing=X] [--room=Y]',
  'memory-wake-up':    'orc memory-wake-up [--wing=X] [--budget=N]',
  'memory-record':     'orc memory-record --content=<text> [--wing=X] [--hall=Y] [--room=Z] [--importance=N]',
  'pr-diff':           'orc pr-diff <pr_ref>',
  'pr-review':         'orc pr-review <pr_ref> --approve|--request-changes --body=<text>',
  'pr-merge':          'orc pr-merge <pr_ref>',
  'pr-status':         'orc pr-status <pr_ref> [--wait]',
  'stop-check':        "orc stop-check   (Claude Stop hook: reads the hook input JSON on stdin)",
};

/** True when the subcommand's own arguments ask for help (before any `--`). */
export function wantsHelp(args: string[]): boolean {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).some((arg) => arg === '--help' || arg === '-h');
}
