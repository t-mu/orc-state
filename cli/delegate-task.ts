#!/usr/bin/env node
/**
 * cli/delegate-task.ts
 * Usage:
 *   node cli/delegate-task.ts --task-ref=<feature/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]
 */
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { withLock } from '../lib/lock.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { listAgents } from '../lib/agentRegistry.ts';
import { selectAutoTarget } from '../lib/dispatchPlanner.ts';
import { canAgentExecuteTask } from '../lib/taskRouting.ts';

import { readBacklog, readClaims } from '../lib/stateReader.ts';
import { TASK_TYPES, AGENT_ID_RE } from '../lib/constants.ts';
import type { Task } from '../types/backlog.ts';

const taskRef = flag('task-ref');
const targetAgentId = flag('target-agent-id');
const taskType = flag('task-type') ?? 'implementation';
const note = flag('note') ?? null;
const actorId = flag('actor-id') ?? 'human';
const actorType = actorId === 'human' ? 'human' : 'agent';

if (!taskRef) {
  console.error('Usage: orc-delegate --task-ref=<feature/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]');
  process.exit(1);
}

if (!AGENT_ID_RE.test(actorId)) {
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

const VALID_TASK_TYPES = new Set(TASK_TYPES);
if (!VALID_TASK_TYPES.has(taskType)) {
  console.error(`Invalid task type: ${taskType}`);
  process.exit(1);
}

const now = new Date().toISOString();

try {
  withLock(join(STATE_DIR, '.lock'), () => {
    const backlogPath = join(STATE_DIR, 'backlog.json');
    const backlog = readBacklog(STATE_DIR);
    const claims = readClaims(STATE_DIR).claims ?? [];
    let task: Task | null = null;
    let featureRef: string | null = null;
    for (const feature of backlog.features ?? []) {
      for (const candidate of feature.tasks ?? []) {
        if (candidate.ref === taskRef) {
          task = candidate;
          featureRef = feature.ref;
          break;
        }
      }
      if (task) break;
    }

    if (!task) {
      throw new Error(`Task not found: ${taskRef}`);
    }

    const allAgents = listAgents(STATE_DIR);
    let assignedTarget: string | null = targetAgentId ?? null;

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

    task.task_type = taskType as Task['task_type'];
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
          feature_ref: featureRef,
          auto_assigned: !targetAgentId,
        },
      },
      { lockAlreadyHeld: true },
    );

    console.log(`task delegated: ${taskRef}${assignedTarget ? ` target=${assignedTarget}` : ''}`);
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
