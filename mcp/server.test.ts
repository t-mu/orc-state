import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools-list.ts';
import { asToolResult, invokeTool, isExpectedToolError, readResource, validateToolArguments } from './server.ts';
import { ControlError } from '../lib/controlProtocol.ts';
import { RevisionConflictError } from '../lib/projectTaskStore.ts';
import { initEventsDb, withEventDbTransaction, closeAllDatabases } from '../lib/eventLog.ts';
import { credentialHash } from '../lib/sessionCredentials.ts';
import { commitClaims } from '../lib/runStore.ts';

let stateDir: string;

beforeEach(() => {
  stateDir = createTempStateDir('orc-mcp-server-test-');
  writeFileSync(joinPath('backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'project', title: 'Project', tasks: [] }],
  }));
  writeFileSync(joinPath('agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' }],
  }));
  writeFileSync(joinPath('claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(joinPath('events.jsonl'), '');
});

afterEach(() => {
  cleanupTempStateDir(stateDir);
});

function joinPath(file: string) {
  return resolve(stateDir, file);
}

describe('orchestrator mcp server foundation', () => {
  it('exports read tools list', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('list_tasks');
    expect(names).toContain('list_agents');
    expect(names).toContain('list_active_runs');
    expect(names).toContain('list_stalled_runs');
    expect(names).toContain('get_task');
    expect(names).toContain('get_recent_events');
    expect(names).toContain('get_status');
    expect(names).toContain('get_agent_workview');
    expect(names).toContain('create_task');
    expect(names).toContain('update_task');
    expect(names).toContain('delegate_task');
    expect(names).toContain('cancel_task');
    expect(names).toContain('request_scout');
    expect(names).toContain('respond_input');
  });

  it('unblocks a blocked task through unblock_task and refuses one that is not blocked', () => {
    writeFileSync(joinPath('backlog.json'), JSON.stringify({ version: '1', features: [{ ref: 'project', title: 'Project', tasks: [
      { ref: 'project/stuck', title: 'Stuck', status: 'blocked', blocked_reason: 'waiting' },
      { ref: 'project/fine', title: 'Fine', status: 'todo' },
    ] }] }));
    expect(invokeTool(stateDir, 'unblock_task', { task_ref: 'project/stuck', reason: 'resolved' }, { project: null })).toMatchObject({ unblocked: true });
    expect(() => invokeTool(stateDir, 'unblock_task', { task_ref: 'project/fine' }, { project: null })).toThrow(/not blocked/);
  });

  it('refuses a worker session on the master\'s scout and unblock tools in a project', async () => {
    writeFileSync(joinPath('agents.json'), JSON.stringify({ version: '1', agents: [
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle', registered_at: '2026-01-01T00:00:00.000Z' },
      { agent_id: 'worker-a', provider: 'claude', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
      { agent_id: 'scout-1', provider: 'claude', role: 'scout', status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
    ] }));
    initEventsDb(stateDir);
    commitClaims(stateDir, { version: '1', claims: [{ run_id: 'run-a', task_ref: 'project/x', agent_id: 'worker-a', state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z' }] });
    withEventDbTransaction(stateDir, (db) => db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at, credential_hash)
      VALUES ('session-a', 'run-a', 'worker-a', 'claude', 'running', '2026-01-01', '2026-01-01', ?)`).run(credentialHash('worker-secret')));
    const asWorker = { project: { id: 'p' }, credential: 'worker-secret' };
    try {
      for (const [tool, args] of [['get_scout_report', { agent_id: 'scout-1' }], ['remove_scout', { agent_id: 'scout-1' }], ['unblock_task', { task_ref: 'project/x' }]] as const) {
        await expect(Promise.resolve().then(() => invokeTool(stateDir, tool, args, asWorker))).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      }
    } finally {
      closeAllDatabases();
    }
  });

  it('server module does not write debug output to stdout', () => {
    const serverSource = readFileSync(resolve(import.meta.dirname, 'server.ts'), 'utf8');
    expect(serverSource).not.toContain('console.log(');
    expect(serverSource).not.toContain('process.stdout.write(');
  });

  it('routes known read tools and throws for unknown tool names', () => {
    const tasks = invokeTool(stateDir, 'list_tasks', {});
    expect(Array.isArray(tasks)).toBe(true);
    expect(() => invokeTool(stateDir, 'unknown_tool', {})).toThrow(/Unknown tool/);
  });

  it('passes refusals the agent can act on through, and keeps system failures internal', () => {
    expect(isExpectedToolError(new ControlError('unavailable', 'The coordinator (pid 1) is running but its control API is not answering; retry', 503))).toBe(true);
    expect(isExpectedToolError(new ControlError('forbidden', 'Only the master session or an operator may send operator mutations', 403))).toBe(true);
    expect(isExpectedToolError(new RevisionConflictError('orch/t', 3, 4))).toBe(true);
    expect(isExpectedToolError(new Error('Input request is not pending for this run'))).toBe(true);
    expect(isExpectedToolError(Object.assign(new Error('ENOENT: no such file'), { errno: -2, code: 'ENOENT' }))).toBe(false);
    expect(isExpectedToolError(new TypeError('x is undefined'))).toBe(false);
    expect(isExpectedToolError(new ControlError('internal', 'disk I/O error', 500))).toBe(false);
  });

  it('rejects a status edit at the update_task schema, before any handler runs', () => {
    expect(validateToolArguments('update_task', { task_ref: 'orch/t', status: 'done' })).toMatchObject({ ok: false });
    expect(isExpectedToolError('boom')).toBe(false);
  });

  it('marks a payload that reports an error as a tool error, keeping its fields', () => {
    expect(asToolResult({ error: 'already_terminal', task_ref: 'orch/t', status: 'done' })).toMatchObject({ isError: true });
    expect(JSON.parse(asToolResult({ error: 'already_terminal', task_ref: 'orch/t' }).content[0].text)).toEqual({ error: 'already_terminal', task_ref: 'orch/t' });
    expect(asToolResult({ cancelled: true })).not.toHaveProperty('isError');
    expect(asToolResult([{ error: 'x' }])).not.toHaveProperty('isError');
  });

  it('reads supported resources and throws for unknown resource uri', () => {
    const backlog = readResource(stateDir, 'orchestrator://state/backlog');
    const agents = readResource(stateDir, 'orchestrator://state/agents');
    expect(backlog.contents[0].mimeType).toBe('application/json');
    expect(agents.contents[0].mimeType).toBe('application/json');
    expect(() => readResource(stateDir, 'orchestrator://state/unknown')).toThrow(McpError);
  });

  it('validates tool arguments against declared input schemas', () => {
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title' }).ok).toBe(true);
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title', priority: 'high' }).ok).toBe(true);
    expect(validateToolArguments('create_task', { title: 'Valid title' }).ok).toBe(true);
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title', description: 'Nope' }).ok).toBe(true);
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title', acceptance_criteria: ['x'] }).ok).toBe(true);
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title', depends_on: ['project/one'] }).ok).toBe(true);
    expect(validateToolArguments('update_task', { task_ref: 'project/task-1', priority: 'critical' }).ok).toBe(true);
    // Definition fields are schema-valid for project tasks; legacy handlers reject them as Markdown-owned.
    expect(validateToolArguments('update_task', { task_ref: 'project/task-1', title: 'Updated title', expected_revision: 1 }).ok).toBe(true);
    expect(validateToolArguments('update_task', { task_ref: 'project/task-1', expected_revision: 0 }).ok).toBe(false);
    expect(validateToolArguments('update_task', { task_ref: 'project/task-1', status: 'done' }).ok).toBe(false);
    expect(validateToolArguments('update_task', { task_ref: 'project/task-1', owner: 'orc-1' }).ok).toBe(false);
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Bad', priority: 'urgent' }).ok).toBe(false);
    expect(validateToolArguments('list_agents', { include_dead: true }).ok).toBe(true);
    expect(validateToolArguments('list_agents', { role: 'scout' }).ok).toBe(true);
    expect(validateToolArguments('get_status', { include_done_count: true }).ok).toBe(true);
    expect(validateToolArguments('request_scout', { objective: 'Inspect stalled run' }).ok).toBe(true);
    expect(validateToolArguments('get_agent_workview', { agent_id: 'master' }).ok).toBe(true);
    expect(validateToolArguments('cancel_task', { task_ref: 'project/task-1' }).ok).toBe(true);
    expect(validateToolArguments('respond_input', { run_id: 'run-1', agent_id: 'orc-1', response: 'yes' }).ok).toBe(true);
    expect(validateToolArguments('create_task', { feature: 'project' }).ok).toBe(false);
    expect(validateToolArguments('list_tasks', { extra: true }).ok).toBe(false);
  });
});
