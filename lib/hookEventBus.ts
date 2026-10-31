import { consumeHookEvents } from './paths.ts';
import { logger } from './logger.ts';

/** A provider permission prompt (Claude `Notification` hook, `permission_prompt`). */
export interface PermissionHookEvent {
  type: 'permission';
  message: string;
  ts: string;
}

/** A tool call observed by the provider harness. */
export interface ToolHookEvent {
  type: 'tool';
  tool: string;
  brief: string;
  ts: string;
}

/** A higher-level activity label (current todo item or a free-form note). An empty `todo` label clears it. */
export interface ActivityHookEvent {
  type: 'activity';
  label: string;
  source: 'todo' | 'note';
  ts: string;
}

export type RunActivityHookEvent = ToolHookEvent | ActivityHookEvent;

export interface DispatchedHookEvents {
  /** Drives input-block detection, exactly as the Notification hook always has. */
  permission: PermissionHookEvent[];
  /** Feeds the per-run activity store and run liveness. */
  activity: RunActivityHookEvent[];
}

function validTs(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Sort raw hook-event records by `type`. Unknown types are ignored; records
 * of a known type that lack their required fields are skipped with a debug
 * log. Permission records stay lenient (message and ts are optional) so the
 * input-block behaviour is unchanged.
 */
export function dispatchHookEvents(records: Array<Record<string, unknown>>, agentId = ''): DispatchedHookEvents {
  const out: DispatchedHookEvents = { permission: [], activity: [] };
  for (const record of records) {
    switch (record.type) {
      case 'permission':
        out.permission.push({
          type: 'permission',
          message: typeof record.message === 'string' ? record.message : '',
          ts: typeof record.ts === 'string' ? record.ts : '',
        });
        break;
      case 'tool':
        if (typeof record.tool !== 'string' || record.tool.length === 0 || !validTs(record.ts)) {
          logger.debug(`[hook-events] skipping malformed tool event for ${agentId}: ${JSON.stringify(record).slice(0, 200)}`);
          break;
        }
        out.activity.push({
          type: 'tool',
          tool: record.tool,
          brief: typeof record.brief === 'string' ? record.brief : '',
          ts: record.ts,
        });
        break;
      case 'activity':
        // An empty `todo` label is a clear (the to-do item finished); an empty note is malformed.
        if (typeof record.label !== 'string' || (record.label.trim().length === 0 && record.source !== 'todo') || !validTs(record.ts)) {
          logger.debug(`[hook-events] skipping malformed activity event for ${agentId}: ${JSON.stringify(record).slice(0, 200)}`);
          break;
        }
        out.activity.push({
          type: 'activity',
          label: record.label.trim(),
          source: record.source === 'todo' ? 'todo' : 'note',
          ts: record.ts,
        });
        break;
      default:
        // Unknown types are ignored, so new hook kinds can ship before their consumer.
        break;
    }
  }
  return out;
}

/**
 * Drain and dispatch an agent's `pty-hook-events/<agent>.ndjson` file.
 * The read is destructive: the coordinator tick is the only caller.
 */
export function drainHookEvents(agentId: string): DispatchedHookEvents {
  return dispatchHookEvents(consumeHookEvents(agentId), agentId);
}
