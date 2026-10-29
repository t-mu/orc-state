#!/usr/bin/env node
/**
 * cli/delegate-task.ts
 * Usage:
 *   node cli/delegate-task.ts --task-ref=<feature/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]
 *
 * In a registered project the running coordinator applies the delegation.
 */
import { flag } from '../lib/args.ts';
import { ACTIVE_PROJECT } from '../lib/paths.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { cliError } from './shared.ts';

const taskRef = flag('task-ref');
const targetAgentId = flag('target-agent-id');
const taskType = flag('task-type') ?? 'implementation';
const note = flag('note') ?? null;
// Without --actor-id: the caller (operator or master session), or human in a legacy installation.
const actorId = flag('actor-id') ?? (ACTIVE_PROJECT ? null : 'human');

if (!taskRef) {
  console.error('Usage: orc delegate --task-ref=<feature/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]');
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({
    op: 'delegate-task', task_ref: taskRef, task_type: taskType, note, ...(actorId ? { actor_id: actorId } : {}),
    ...(targetAgentId ? { target_agent_id: targetAgentId } : {}),
  });
  console.log(`task delegated: ${taskRef}${typeof result.assigned_to === 'string' ? ` target=${result.assigned_to}` : ''}`);
  // No eligible worker: the task waits for one; show why each candidate was skipped, as the MCP tool does.
  if (typeof result.warning === 'string') {
    console.error(`warning: ${result.warning}`);
    if (result.candidate_diagnostics !== undefined) console.error(JSON.stringify(result.candidate_diagnostics, null, 2));
  }
} catch (error) {
  cliError(error);
}
