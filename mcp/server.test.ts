import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools-list.ts';
import { invokeTool, readResource, validateToolArguments } from './server.ts';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(resolve(tmpdir(), 'orc-mcp-server-test-'));
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
  rmSync(stateDir, { recursive: true, force: true });
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
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title', description: 'Nope' }).ok).toBe(false);
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title', acceptance_criteria: ['x'] }).ok).toBe(false);
    expect(validateToolArguments('create_task', { feature: 'project', title: 'Valid title', depends_on: ['project/one'] }).ok).toBe(false);
    expect(validateToolArguments('update_task', { task_ref: 'project/task-1', priority: 'critical' }).ok).toBe(true);
    expect(validateToolArguments('update_task', { task_ref: 'project/task-1', title: 'Updated title' }).ok).toBe(false);
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
