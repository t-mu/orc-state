import { unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let stateDir: string;
let child: ChildProcess;
let nextId: number;
let buffer: string;
let pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
let parseFailure: Error | null;

function seedState(dir: string) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'project',
      title: 'Project',
      tasks: [{
        ref: 'project/todo-one',
        title: 'Todo one',
        status: 'todo',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: 'master',
      provider: 'claude',
      role: 'master',
      status: 'idle',
      session_handle: null,
      capabilities: [],
      last_heartbeat_at: null,
      registered_at: '2026-01-01T00:00:00.000Z',
    }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function onStdoutData(chunk: Buffer) {
  buffer += chunk.toString('utf8');
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      parseFailure = new Error(`Malformed JSON-RPC output line: ${line}`);
      for (const [id, handlers] of pending.entries()) {
        pending.delete(id);
        handlers.reject(parseFailure);
      }
      return;
    }

    if (message.id != null && pending.has(message.id)) {
      const handlers = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.jsonrpc !== '2.0') {
        handlers.reject(new Error(`Invalid JSON-RPC version in response: ${String(message.jsonrpc)}`));
        continue;
      }
      if ((message.result != null && message.error != null) || (message.result == null && message.error == null)) {
        handlers.reject(new Error('JSON-RPC response must have exactly one of result or error'));
        continue;
      }
      if (message.error) {
        handlers.reject(message.error);
      } else {
        handlers.resolve(message.result);
      }
    }
  }
}

function sendRequest(method: string, params: Record<string, unknown> = {}) {
  if (parseFailure) {
    return Promise.reject(parseFailure);
  }
  const id = nextId;
  nextId += 1;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin!.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Timed out waiting for response to ${method}`));
    }, 3000);

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      },
    });
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return sendRequest('tools/call', { name, arguments: args });
}

beforeEach(async () => {
  stateDir = createTempStateDir('orc-mcp-protocol-test-');
  seedState(stateDir);

  nextId = 1;
  buffer = '';
  pending = new Map();
  parseFailure = null;

  const serverPath = resolve(import.meta.dirname, 'server.ts');
  child = spawn(process.execPath, ['--experimental-strip-types', serverPath], {
    env: { ...process.env, ORCH_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', onStdoutData);

  await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
});

afterEach(async () => {
  if (!child) return;
  child.stdout!.off('data', onStdoutData);
  child.stdin!.end();

  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, 1000);

    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });

  cleanupTempStateDir(stateDir);
});

describe('mcp stdio protocol', () => {
  it('lists tools over JSON-RPC', async () => {
    const result = await sendRequest('tools/list', {}) as Record<string, unknown>;
    const names = (result.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
    expect(names).toContain('list_tasks');
    expect(names).toContain('create_task');
    expect(names).toContain('get_status');
    expect(names).toContain('get_agent_workview');
  });

  it('executes read tools over JSON-RPC', async () => {
    const result = await callTool('list_tasks', {}) as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content as Array<Record<string, unknown>>)[0].text as string);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.some((task: Record<string, unknown>) => task.ref === 'project/todo-one')).toBe(true);
  });

  it('lists and executes get_agent_workview over JSON-RPC', async () => {
    const result = await callTool('get_agent_workview', { agent_id: 'master' }) as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content as Array<Record<string, unknown>>)[0].text as string);
    expect(payload.agent.agent_id).toBe('master');
    expect(payload.recommended_action).toBe('idle');
  });

  it('returns protocol InvalidParams for malformed tool arguments', async () => {
    await expect(callTool('create_task', { feature: 'project' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('returns protocol InvalidParams for unknown tool names', async () => {
    await expect(callTool('unknown_tool_name', {})).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('returns tool-level isError for domain/runtime failures', async () => {
    const result = await callTool('delegate_task', {
      task_ref: 'project/missing-task',
      actor_id: 'master',
    }) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].text).toContain('Task not found');
    expect(() => JSON.parse(content[0].text as string)).not.toThrow();
  });

  it('supports resources/list and resources/read over JSON-RPC', async () => {
    const listResult = await sendRequest('resources/list', {}) as Record<string, unknown>;
    const uris = (listResult.resources as Array<Record<string, unknown>>).map((resource) => resource.uri);
    expect(uris).toContain('orchestrator://state/backlog');
    expect(uris).toContain('orchestrator://state/agents');

    const readResult = await sendRequest('resources/read', { uri: 'orchestrator://state/backlog' }) as Record<string, unknown>;
    const contents = readResult.contents as Array<Record<string, unknown>>;
    expect(contents[0].mimeType).toBe('application/json');
    const backlog = JSON.parse(contents[0].text as string);
    expect(backlog.features[0].ref).toBe('project');
  });

  it('returns InvalidParams for unknown resources/read uri', async () => {
    await expect(sendRequest('resources/read', { uri: 'orchestrator://state/unknown' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('returns protocol InternalError for unexpected tool execution failures', async () => {
    unlinkSync(join(stateDir, 'backlog.json'));
    await expect(callTool('list_tasks', {})).rejects.toMatchObject({
      code: -32603,
    });
  });
});
