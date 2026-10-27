#!/usr/bin/env node
/**
 * cli/delegate-task.ts
 * Usage:
 *   node cli/delegate-task.ts --task-ref=<feature/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]
 *
 * In a registered project the running coordinator applies the delegation.
 */
import { flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorMutations.ts';
import { cliError } from './shared.ts';

const taskRef = flag('task-ref');
const targetAgentId = flag('target-agent-id');
const taskType = flag('task-type') ?? 'implementation';
const note = flag('note') ?? null;
const actorId = flag('actor-id') ?? 'human';

if (!taskRef) {
  console.error('Usage: orc delegate --task-ref=<feature/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]');
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({
    op: 'delegate-task', task_ref: taskRef, task_type: taskType, note, actor_id: actorId,
    ...(targetAgentId ? { target_agent_id: targetAgentId } : {}),
  });
  console.log(`task delegated: ${taskRef}${typeof result.assigned_to === 'string' ? ` target=${result.assigned_to}` : ''}`);
} catch (error) {
  cliError(error);
}
