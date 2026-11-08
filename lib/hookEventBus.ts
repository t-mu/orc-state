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
  /** The sub-agent type of an `Agent`/`Task` call, when the harness reported one. */
  subagent_type?: string;
  /** The harness's tool_use_id, when reported: closes the matching `tool_start`. */
  id?: string;
  ts: string;
}

/** A tool call the harness is about to run (Claude `PreToolUse *`); its `tool` record closes it. */
export interface ToolStartHookEvent {
  type: 'tool_start';
  tool: string;
  /** The harness's tool_use_id, when reported. */
  id?: string;
  ts: string;
}

/** A higher-level activity label (current todo item or a free-form note). An empty `todo` label clears it. */
export interface ActivityHookEvent {
  type: 'activity';
  label: string;
  source: 'todo' | 'note';
  ts: string;
}

/**
 * The worker's turn ended (its Stop hook ran `orc stop-check`; the coordinator
 * appends this record). No tool call runs once the turn is over, so it closes
 * every tool call started at or before `ts`, including one that never got a
 * PostToolUse/PostToolUseFailure record (refused at the permission step).
 */
export interface TurnEndHookEvent {
  type: 'turn_end';
  ts: string;
}

/**
 * The provider session started (Claude `SessionStart` hook): its readiness
 * signal. `session_id` is the provider's conversation id; `orc_session_id`, when
 * present, names the orc session that started (stale records do not match).
 */
export interface SessionStartHookEvent {
  type: 'session_start';
  session_id: string;
  source: string;
  orc_session_id?: string;
  ts: string;
}

export type RunActivityHookEvent = ToolHookEvent | ToolStartHookEvent | ActivityHookEvent | TurnEndHookEvent;

export interface DispatchedHookEvents {
  /** Drives input-block detection, exactly as the Notification hook always has. */
  permission: PermissionHookEvent[];
  /** Feeds the per-run activity store and run liveness. */
  activity: RunActivityHookEvent[];
  /** Marks the session ready (lib/sessionStartReadiness.ts). */
  sessionStart: SessionStartHookEvent[];
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
  const out: DispatchedHookEvents = { permission: [], activity: [], sessionStart: [] };
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
          ...(typeof record.subagent_type === 'string' && record.subagent_type.length > 0
            ? { subagent_type: record.subagent_type } : {}),
          ...(typeof record.id === 'string' && record.id.length > 0 ? { id: record.id } : {}),
          ts: record.ts,
        });
        break;
      case 'tool_start':
        if (typeof record.tool !== 'string' || record.tool.length === 0 || !validTs(record.ts)) {
          logger.debug(`[hook-events] skipping malformed tool_start event for ${agentId}: ${JSON.stringify(record).slice(0, 200)}`);
          break;
        }
        out.activity.push({
          type: 'tool_start',
          tool: record.tool,
          ...(typeof record.id === 'string' && record.id.length > 0 ? { id: record.id } : {}),
          ts: record.ts,
        });
        break;
      case 'session_start':
        if (!validTs(record.ts)) {
          logger.debug(`[hook-events] skipping malformed session_start event for ${agentId}: ${JSON.stringify(record).slice(0, 200)}`);
          break;
        }
        out.sessionStart.push({
          type: 'session_start',
          session_id: typeof record.session_id === 'string' ? record.session_id : '',
          source: typeof record.source === 'string' ? record.source : '',
          ...(typeof record.orc_session_id === 'string' && record.orc_session_id.length > 0 ? { orc_session_id: record.orc_session_id } : {}),
          ts: record.ts,
        });
        break;
      case 'turn_end':
        if (!validTs(record.ts)) {
          logger.debug(`[hook-events] skipping malformed turn_end event for ${agentId}: ${JSON.stringify(record).slice(0, 200)}`);
          break;
        }
        out.activity.push({ type: 'turn_end', ts: record.ts });
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
