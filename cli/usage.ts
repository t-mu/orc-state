/**
 * cli/usage.ts
 * One usage synopsis per `orc` subcommand. The dispatcher prints it for
 * `orc <subcommand> --help` (or `-h`) instead of running the command, so
 * asking a state-changing command for help can never execute it.
 */
export const USAGE: Record<string, string> = {
  'coordinator':       'orc coordinator <start|stop|restart|status> [--json]   (the coordinator only: no master; stop/restart keep tasks and worktrees)',
  'start-session':     'orc start-session [--provider=<claude|codex|gemini>] [--agent-id=<id>] [--reset] [--restart-stale]',
  'status':            'orc status [--json [--events=<0-200>]] [--mine --agent-id=<id>] [--watch|-w [--interval-ms=<ms>] [--once]]',
  'watch':             'orc watch [--interval-ms=<ms>] [--once]',
  'attach':            'orc attach <agent_id|run_id> [--write]',
  'task-mark-done':    'orc task-mark-done <task_ref> [--actor-id=<id>] [--json]',
  'delegate':          'orc delegate --task-ref=<feature/task> [--target-agent-id=<id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<id>] [--json]',
  'progress':          'orc progress --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--note=<text>] [--policy=<requeue|block>]',
  'doctor':            'orc doctor [--json] [--stale-progress-ms=<ms>] [--stale-start-ms=<ms>]',
  'preflight':         'orc preflight [--json]',
  'init':              'orc init [--provider=claude,codex,gemini] [--worker-provider=<name>]',
  'project':           'orc project add <git-path> [--name=N] | list [--json] | select <id> | show | config <list|get|set|unset> [key] [value] [--global] | task <list [--status=<s>[,<s>]] [--feature=<f>]|show [--revision=<n>]|revisions|create|edit --expected-revision=<n>|import [--strict]|export [--ref=a,b]> [ref|path] | plan <list|show|import|export> [id|path]   (all accept --project=<id>)',
  'runs-active':       'orc runs-active [--json] [--via-control]',
  'events':            'orc events [--run-id=<id>] [--agent-id=<id>] [--task-ref=<ref>] [--event=<type>] [--notifications] [--after=<seq>] [--limit=<1-100>] [--fts=<query>] [--verbose] [--json] [--follow [--max-events=<n>]]',
  'event-cursor':      'orc event-cursor [--consumer=<id>] [--reset-to=<seq>]   (reset requires a stopped coordinator)',
  'control':           'orc control snapshot | events [--after=<seq>] [--limit=<n>] [--follow] [--max-events=<n>] | command --run-id=<id> --recipient-session=<id> --kind=<kind> --idempotency-key=<key> [--payload=<json>] [--credential=<secret>] | ack <command_id> --state=<accepted|running|completed|failed> [--credential=<secret>] | message --run-id=<id> (--recipient-session=<id>|--recipient-agent=<id>) --kind=<kind> --text=<text> --idempotency-key=<key> [--artifact-ref=<ref>] [--parent-message=<id>] | messages [--include-consumed] | consume <message_id>',
  'terminal':          'orc terminal <provider|shell> <run_id> [--write [--takeover]] [--once]',
  'sessions':          'orc sessions [--all] [--json]',
  'run-start':         'orc run-start --run-id=<id> --agent-id=<id>',
  'report-for-duty':   'orc report-for-duty --agent-id=<id> --session-id=<id>   (--session-token is an alias of --session-id)',
  'run-input-request': 'orc run-input-request --run-id=<id> --agent-id=<id> --question=<text> [--timeout-ms=<ms>] [--poll-ms=<ms>]',
  'run-input-respond': 'orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>] [--json]',
  'run-heartbeat':     'orc run-heartbeat   (deprecated no-op: leases renew automatically)',
  'run-work-complete': 'orc run-work-complete --run-id=<id> --agent-id=<id>',
  'run-finish':        'orc run-finish --run-id=<id> --agent-id=<id>',
  'run-fail':          'orc run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--code=<code>] [--policy=<requeue|block>]',
  'review-submit':     'orc review-submit --run-id=<id> --agent-id=<worker_id> --outcome=<approved|findings> --reason=<text> [--reviewer=<label>]',
  'review-read':       'orc review-read --run-id=<id> [--json]',
  'worker-remove':     'orc worker-remove <worker_id> [--keep-session] [--json]',
  'worker-gc':         'orc worker-gc [--json]',
  'kill-all':          'orc kill-all [--keep-sessions] [--json]   (stops the coordinator, resets active tasks, removes run worktrees)',
  'mcp-server':        'orc mcp-server   (stdio MCP server; started by orc start-session)',
  'install':           'orc install [--provider=claude,codex,gemini] [--global] [--dry-run] [--skip-skills] [--skip-agents]',
  'install-agents':    'orc install-agents [--provider=claude,codex,gemini] [--global] [--dry-run]',
  'install-skills':    'orc install-skills [--provider=claude,codex,gemini] [--global] [--dry-run]',
  'waiting-input':     'orc waiting-input [--json]',
  'run-info':          'orc run-info <run_id> [--json]',
  'task-reset':        'orc task-reset <task_ref> [--actor-id=<id>] [--json]',
  'task-unblock':      'orc task-unblock <task_ref> [--reason=<text>] [--actor-id=<id>] [--json]',
  'task-cancel':       'orc task-cancel <task_ref> [--reason=<text>] [--actor-id=<id>] [--json]',
  'run-expire':        'orc run-expire <run_id> [--json]',
  'run-close':         'orc run-close <run_id> [--reason=<text>] [--actor-id=<id>] [--json]',
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
