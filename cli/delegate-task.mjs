#!/usr/bin/env node
/**
 * cli/delegate-task.mjs
 * Usage:
 *   node cli/delegate-task.mjs --task-ref=<epic/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from '../lib/args.mjs';
import { withLock } from '../lib/lock.mjs';
import { atomicWriteJson } from '../lib/atomicWrite.mjs';
import { appendSequencedEvent } from '../lib/eventLog.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { listAgents } from '../lib/agentRegistry.mjs';
import { selectAutoTarget } from '../lib/dispatchPlanner.mjs';
import { canAgentExecuteTask } from '../lib/taskRouting.mjs';
import { readClaims } from '../lib/stateReader.mjs';

const taskRef = flag('task-ref');
const targetAgentId = flag('target-agent-id');
const taskType = flag('task-type') ?? 'implementation';
const note = flag('note') ?? null;
const actorId = flag('actor-id') ?? 'human';
const actorType = actorId === 'human' ? 'human' : 'agent';

if (!taskRef) {
  console.error('Usage: orc-delegate --task-ref=<epic/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(actorId)) {
  console.error(`Invalid actor-id: ${actorId}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  process.exit(1);
}

if (actorId !== 'human') {
  const allAgentsCheck = listAgents(STATE_DIR);
  const actorExists = allAgentsCheck.some((a) => a.agent_id === actorId);
  if (!actorExists) {
    console.error(`Actor agent not found: ${actorId}. Registered agents: ${allAgentsCheck.map((a) => a.agent_id).join(', ') || '(none)'}`);
    process.exit(1);
  }
}

const VALID_TASK_TYPES = new Set(['implementation', 'refactor']);
if (!VALID_TASK_TYPES.has(taskType)) {
  console.error(`Invalid task type: ${taskType}`);
  process.exit(1);
}

const now = new Date().toISOString();

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const backlog = JSON.parse(readFileSync(backlogPath, 'utf8'));
    const claims = readClaims(STATE_DIR).claims ?? [];
    let task = null;
    let epicRef = null;
    for (const epic of backlog.epics ?? []) {
      for (const candidate of epic.tasks ?? []) {
        if (candidate.ref === taskRef) {
          task = candidate;
          epicRef = epic.ref;
          break;
        }
      }
      if (task) break;
    }

    if (!task) {
      throw new Error(`Task not found: ${taskRef}`);
    }

    const allAgents = listAgents(STATE_DIR);
    let assignedTarget = targetAgentId;

    if (assignedTarget) {
      const target = allAgents.find((a) => a.agent_id === assignedTarget);
      if (!target) throw new Error(`Target agent not found: ${assignedTarget}`);
      if (!canAgentExecuteTask({ ...task, task_type: taskType }, target)) {
        throw new Error(`Target agent ${assignedTarget} cannot execute task type ${taskType}`);
      }
    } else {
      assignedTarget = selectAutoTarget({
        task,
        taskType,
        allAgents,
        claims,  // array of claim objects
        stateDir: STATE_DIR,
      });
    }

    task.task_type = taskType;
    task.planning_state = 'ready_for_dispatch';
    task.delegated_by = actorId;
    if (assignedTarget) {
      task.owner = assignedTarget;
    } else if (task.owner) {
      delete task.owner;
    }
    if (task.status === 'blocked') task.status = 'todo';
    task.updated_at = now;
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      STATE_DIR,
      {
        ts: now,
        event: 'task_delegated',
        actor_type: actorType,
        actor_id: actorId,
        task_ref: taskRef,
        ...(assignedTarget ? { agent_id: assignedTarget } : {}),
        payload: {
          target_agent_id: assignedTarget ?? null,
          task_type: taskType,
          note,
          epic_ref: epicRef,
          auto_assigned: !targetAgentId,
        },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task delegated: ${taskRef}${assignedTarget ? ` target=${assignedTarget}` : ''}`);
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
