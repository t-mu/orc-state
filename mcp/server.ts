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
import { STATE_DIR } from '../lib/paths.ts';
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
    description: 'Full backlog.json with all features and tasks',
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

function asToolResult(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function asToolError(message: unknown) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: String(message) }) }],
  };
}

function isExpectedToolError(err: unknown) {
  if (!(err instanceof Error)) return false;
  return /(Invalid|required|not found|already exists|cannot execute|must be|Unknown tool)/i.test(err.message);
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

export function invokeTool(stateDir: string, name: string, args: Record<string, unknown> = {}) {
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[orc-mcp] server started\n');
}

if (isEntryPoint()) {
  await startServer();
}

export { TOOLS };
