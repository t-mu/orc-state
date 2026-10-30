#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createOrchestratorAjv } from '../lib/ajvFactory.ts';
import { ACTIVE_PROJECT, assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { masterForCredential, type OperatorOp } from '../lib/operatorMutations.ts';
import { ForbiddenError } from '../lib/domainErrors.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { clientCredential } from '../lib/sessionCredentials.ts';
import { ControlError } from '../lib/controlProtocol.ts';
import { submitProjectWrite } from '../lib/projectWriteDispatch.ts';
import { projectTaskStoreFor } from '../lib/projectTasks.ts';
import * as handlers from './handlers.ts';
import { TOOLS } from './tools-list.ts';

const server = new Server(
  { name: 'orchestrator', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

const RESOURCES = [
  {
    uri: 'orchestrator://state/backlog',
    name: 'Backlog',
    description: 'Full backlog.json with all features and tasks. In a registered project it is a read-only projection of the task store: change tasks with create_task/update_task and the lifecycle tools, never by editing it.',
    mimeType: 'application/json',
  },
  {
    uri: 'orchestrator://state/agents',
    name: 'Agents',
    description: 'Registered agents and runtime status',
    mimeType: 'application/json',
  },
];

const ajv = createOrchestratorAjv();
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const TOOL_VALIDATORS = new Map(
  TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);

/** A payload that reports an `error` (cancel_task's already_terminal, a memory failure) is a tool error too. */
export function asToolResult(payload: unknown) {
  const failed = typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string';
  return {
    ...(failed ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function asToolError(message: unknown) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: String(message) }) }],
  };
}

/**
 * A refusal the agent can act on: the coordinator's refusals (not its `internal` failures), task input and revision conflicts, lifecycle
 * rules. A system or SQLite failure, or a programming error, is internal; its stack goes to stderr.
 */
export function isExpectedToolError(err: unknown) {
  if (!(err instanceof Error)) return false;
  // The coordinator's own unexpected failure is internal too, not a refusal the agent should act on.
  if (err instanceof ControlError) return err.code !== 'internal';
  if ('errno' in err || err.name === 'SqliteError') return false;
  return !(err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError);
}

export function validateToolArguments(name: string, args: Record<string, unknown> = {}) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const validate = TOOL_VALIDATORS.get(name);
  const valid = validate!(args);
  if (valid) return { ok: true };
  const first = validate!.errors?.[0];
  if (!first) return { ok: false, error: `Invalid arguments for tool: ${name}` };
  const path = first.instancePath?.length ? first.instancePath : '(root)';
  return { ok: false, error: `Invalid arguments for ${name}: ${path} ${first.message}` };
}

/** Master tools that mutate a project's runtime state; the coordinator applies them (task 232). */
const OPERATOR_TOOLS: Readonly<Record<string, OperatorOp>> = {
  cancel_task: 'cancel-task', reset_task: 'reset-task', unblock_task: 'unblock-task', delegate_task: 'delegate-task', respond_input: 'respond-input',
};

/**
 * Tools that change orchestration state, with what an operator without the master session can do instead.
 * Only the master session may call them.
 */
const MASTER_WRITE_TOOLS: Readonly<Record<string, string>> = {
  create_task: 'orc project task create', update_task: 'orc project task edit',
  cancel_task: 'orc task-cancel', reset_task: 'orc task-reset', unblock_task: 'orc task-unblock', delegate_task: 'orc delegate',
  memory_store: 'orc memory-record',
};
const MASTER_ONLY_TOOLS: ReadonlySet<string> = new Set(['respond_input', 'request_scout', 'remove_scout']);

export function invokeTool(stateDir: string, name: string, args: Record<string, unknown> = {},
  { project = ACTIVE_PROJECT, credential = clientCredential(process.env) }: { project?: unknown; credential?: string | null } = {}) {
  if (project && !credential && (Object.hasOwn(MASTER_WRITE_TOOLS, name) || MASTER_ONLY_TOOLS.has(name))) {
    const instead = MASTER_WRITE_TOOLS[name];
    throw new ForbiddenError(`${name} needs the master session (ORC_MASTER_SECRET, set by orc start-session). `
      + (instead ? `As the operator, use the orc CLI instead: ${instead}` : 'Only the master can do this; start it with orc start-session'));
  }
  const op = OPERATOR_TOOLS[name];
  if (op && project) {
    // The server presents the session it runs in: the master's (from start-session) acts as the master,
    // and a worker's is refused like its shell.
    return submitOperatorMutation({ op, ...args }, { credential, project, stateDir });
  }
  if (name === 'request_scout' && project) {
    // Only the master's session may launch scouts; it acts as itself.
    return handlers.handleRequestScout(stateDir, { ...args, actor_id: masterForCredential(stateDir, credential!) });
  }
  if ((name === 'get_scout_report' || name === 'remove_scout') && project && credential) {
    // Scouts are the master's: a worker session cannot read or stop them.
    masterForCredential(stateDir, credential);
  }
  // The master acts as itself: the coordinator records the session's agent.
  if (project && projectTaskStoreFor(stateDir) && name === 'create_task') {
    return submitProjectWrite<unknown>(stateDir, 'create_task', undefined,
      async (client) => (await client.createTask(args, undefined)).task,
      (actor) => handlers.handleCreateTask(stateDir, { ...args, actor_id: actor }), { credential });
  }
  if (project && projectTaskStoreFor(stateDir) && name === 'update_task') {
    const { task_ref, expected_revision, ...changes } = args;
    return submitProjectWrite<unknown>(stateDir, 'update_task', undefined,
      async (client) => {
        const result = await client.reviseTask(task_ref as string, expected_revision as number, changes, undefined);
        return { ...result.task, changed: result.changed };
      },
      (actor) => handlers.handleUpdateTask(stateDir, { ...args, actor_id: actor }), { credential });
  }
  switch (name) {
    case 'list_tasks':
      return handlers.handleListTasks(stateDir, args);
    case 'list_agents':
      return handlers.handleListAgents(stateDir, args);
    case 'list_active_runs':
      return handlers.handleListActiveRuns(stateDir);
    case 'list_stalled_runs':
      return handlers.handleListStalledRuns(stateDir, args);
    case 'get_task':
      return handlers.handleGetTask(stateDir, args);
    case 'get_recent_events':
      return handlers.handleGetRecentEvents(stateDir, args);
    case 'get_status':
      return handlers.handleGetStatus(stateDir, args);
    case 'get_agent_workview':
      return handlers.handleGetAgentWorkview(stateDir, args);
    case 'create_task':
      return handlers.handleCreateTask(stateDir, args);
    case 'update_task':
      return handlers.handleUpdateTask(stateDir, args);
    case 'delegate_task':
      return handlers.handleDelegateTask(stateDir, args);
    case 'cancel_task':
      return handlers.handleCancelTask(stateDir, args);
    case 'request_scout':
      return handlers.handleRequestScout(stateDir, args);
    case 'get_scout_report':
      return handlers.handleGetScoutReport(stateDir, args);
    case 'remove_scout':
      return handlers.handleRemoveScout(stateDir, args);
    case 'respond_input':
      return handlers.handleRespondInput(stateDir, args);
    case 'get_run':
      return handlers.handleGetRun(stateDir, args);
    case 'list_waiting_input':
      return handlers.handleListWaitingInput(stateDir);
    case 'query_events':
      return handlers.handleQueryEvents(stateDir, args);
    case 'reset_task':
      return handlers.handleResetTask(stateDir, args);
    case 'unblock_task':
      return handlers.handleUnblockTask(stateDir, args);
    case 'list_worktrees':
      return handlers.handleListWorktrees(stateDir);
    case 'get_notifications':
      return handlers.handleGetNotifications(stateDir, args);
    case 'memory_wake_up':
      return handlers.handleMemoryWakeUp(stateDir, args);
    case 'memory_recall':
      return handlers.handleMemoryRecall(stateDir, args);
    case 'memory_search':
      return handlers.handleMemorySearch(stateDir, args);
    case 'memory_store':
      return handlers.handleMemoryStore(stateDir, args);
    case 'memory_status':
      return handlers.handleMemoryStatus(stateDir, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function readResource(stateDir: string, uri: string) {
  if (uri === 'orchestrator://state/backlog') {
    return {
      contents: [{ uri, mimeType: 'application/json', text: handlers.handleReadBacklog(stateDir) }],
    };
  }
  if (uri === 'orchestrator://state/agents') {
    return {
      contents: [{ uri, mimeType: 'application/json', text: handlers.handleReadAgents(stateDir) }],
    };
  }
  throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
}

server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const validation = validateToolArguments(name, args);
  if (!validation.ok) {
    throw new McpError(ErrorCode.InvalidParams, validation.error!);
  }

  try {
    const payload = await invokeTool(STATE_DIR, name, args);
    return asToolResult(payload);
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (isExpectedToolError(err)) {
      return asToolError((err as Error).message);
    }
    process.stderr.write(`[orc-mcp] ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    throw new McpError(ErrorCode.InternalError, 'Internal MCP tool execution failure');
  }
});

server.setRequestHandler(ListResourcesRequestSchema, () => Promise.resolve({ resources: RESOURCES }));

server.setRequestHandler(ReadResourceRequestSchema, (request) => Promise.resolve(readResource(STATE_DIR, request.params.uri)));

function isEntryPoint() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

export async function startServer() {
  assertProjectMode();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[orc-mcp] server started\n');
}

if (isEntryPoint()) {
  await startServer();
}

export { TOOLS };
