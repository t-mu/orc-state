#!/usr/bin/env node
/**
 * cli/delegate-task.ts
 * Usage:
 *   node cli/delegate-task.ts --task-ref=<feature/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>] [--json]
 *
 * The project's running coordinator applies the delegation.
 */
import { boolFlag, flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const taskRef = flag('task-ref');
const targetAgentId = flag('target-agent-id');
const taskType = flag('task-type') ?? 'implementation';
const note = flag('note') ?? null;
// Without --actor-id: the caller (operator or master session).
const actorId = flag('actor-id');
const json = boolFlag('json');

if (!taskRef) {
  console.error(`Usage: ${USAGE['delegate']}`);
  process.exit(1);
}

try {
  const result = await submitOperatorMutation({
    op: 'delegate-task', task_ref: taskRef, task_type: taskType, note, ...(actorId ? { actor_id: actorId } : {}),
    ...(targetAgentId ? { target_agent_id: targetAgentId } : {}),
  });
  if (json) {
    printJson(result);
  } else {
    console.log(`task delegated: ${taskRef}${typeof result.assigned_to === 'string' ? ` target=${result.assigned_to}` : ''}`);
    // No eligible worker: the task waits for one; show why each candidate was skipped, as the MCP tool does.
    if (typeof result.warning === 'string') {
      console.error(`warning: ${result.warning}`);
      if (result.candidate_diagnostics !== undefined) console.error(JSON.stringify(result.candidate_diagnostics, null, 2));
    }
  }
} catch (error) {
  await failCommand(error, json);
}
