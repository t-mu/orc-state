#!/usr/bin/env node
/**
 * cli/kill-all.ts
 *
 * Tear down the orchestrator: stop the coordinator, terminate all agent
 * sessions, and clear the registry.
 *
 * Usage:
 *   orc-kill-all [--keep-sessions]
 *
 * --keep-sessions  Leave every agent session running and adoptable: its agent
 *                  record, session row, run and worktree are kept, so the next
 *                  `orc start-session` adopts it. Everything else is reset.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join }                     from 'node:path';
import { listAgents }               from '../lib/agentRegistry.ts';
import { createAdapter }            from '../adapters/index.ts';
import { assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { atomicWriteJson }          from '../lib/atomicWrite.ts';
import { withLock }                 from '../lib/lock.ts';
import { cleanupRunWorktree }       from '../lib/runWorktree.ts';
import { RUN_WORKTREES_FILE }       from '../lib/paths.ts';
import { readBacklog, readClaims }  from '../lib/stateReader.ts';
import { closeProviderSessionsForAgent, commitClaims } from '../lib/runStore.ts';
import { boolFlag }                 from '../lib/args.ts';
import { cliError, formatErrorMessage } from './shared.ts';
import { commitBacklog } from '../lib/projectTasks.ts';
import { findLiveCoordinator, isCoordinatorLockHeld, type CoordinatorLock } from '../lib/coordinatorLiveness.ts';

const keepSessions = boolFlag('keep-sessions');

try {
  assertProjectMode();
} catch (error) {
  cliError(error);
}

// ── Step 1: Kill coordinator ────────────────────────────────────────────────

const pidFile = join(STATE_DIR, 'coordinator.pid');
let lock: CoordinatorLock | null = null;
if (existsSync(pidFile)) {
  try {
    lock = JSON.parse(readFileSync(pidFile, 'utf8')) as CoordinatorLock | null;
  } catch { /* stale */ }
}
const lockPid = typeof lock?.pid === 'number' ? lock.pid : undefined;
const staleLock = Boolean(lockPid) && !isCoordinatorLockHeld(lock);
if (staleLock) {
  // The PID is dead, or now belongs to another process: never signal it.
  try { unlinkSync(pidFile); } catch { /* already gone */ }
}
// A coordinator whose pid lock went missing is still found through control.json.
const coordinator = findLiveCoordinator(STATE_DIR);
if (coordinator) {
  const { pid, source } = coordinator;
  const via = source === 'control_json' ? ', found via control.json; coordinator.pid was missing or stale' : '';
  try {
    process.kill(pid, 'SIGTERM');
    // Poll up to 2 s (10 × 200 ms) for the process to exit
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { process.kill(pid, 0); } catch { break; } // ESRCH = dead, stop polling
    }
    console.log(`✓ Coordinator stopped  (PID ${pid}${via})`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      if (source === 'pid_file') { try { unlinkSync(pidFile); } catch { /* already gone */ } }
      console.log('  Coordinator already stopped');
    } else {
      console.error(`  Warning: could not signal coordinator: ${formatErrorMessage(e)}`);
    }
  }
} else if (staleLock) {
  console.log('  Coordinator already stopped');
} else {
  console.log('  Coordinator not running');
}

// ── Step 2: Stop all agent sessions ────────────────────────────────────────

const agents = listAgents(STATE_DIR);
const liveAgents = agents.filter((a) => a.session_handle);

if (!keepSessions) {
  for (const agent of liveAgents) {
    try {
      const adapter = createAdapter(agent.provider);
      await adapter.stop(agent.session_handle!);
      console.log(`✓ Stopped session for ${agent.agent_id}`);
    } catch (e) {
      console.error(`  Warning: could not stop session for ${agent.agent_id}: ${formatErrorMessage(e)}`);
    }
  }
}

// ── Step 3–4: Clear the agent registry, cancel active claims ───────────────
// Under the state lock. With --keep-sessions, an agent with a session keeps its
// record, its session row and its active run, so the next coordinator adopts it.

const keptAgentIds = new Set(keepSessions ? liveAgents.map((agent) => agent.agent_id) : []);
const keptRunIds = new Set<string>();

withLock(join(STATE_DIR, '.lock'), () => {
  const now = new Date().toISOString();
  if (existsSync(join(STATE_DIR, 'agents.json'))) {
    for (const agent of agents) {
      if (!keptAgentIds.has(agent.agent_id)) closeProviderSessionsForAgent(STATE_DIR, agent.agent_id, now);
    }
    atomicWriteJson(join(STATE_DIR, 'agents.json'), {
      version: '1', agents: listAgents(STATE_DIR).filter((agent) => keptAgentIds.has(agent.agent_id)),
    });
  }
  console.log(`✓ Cleared ${agents.length - keptAgentIds.size} agent(s)${keptAgentIds.size ? `, kept ${keptAgentIds.size} with a live session` : ''}`);

  if (!existsSync(join(STATE_DIR, 'backlog.json')) || !existsSync(join(STATE_DIR, 'claims.json'))) return;
  const backlog = readBacklog(STATE_DIR);
  const claimsState = readClaims(STATE_DIR);

  let cancelledClaims = 0;
  const cancelledRuns: Array<{ run_id: string; task_ref: string; agent_id: string }> = [];
  const keptTaskRefs = new Set<string>();
  for (const claim of claimsState.claims ?? []) {
    if (claim.state !== 'claimed' && claim.state !== 'in_progress') continue;
    if (keptAgentIds.has(claim.agent_id)) {
      keptRunIds.add(claim.run_id);
      keptTaskRefs.add(claim.task_ref);
      continue;
    }
    claim.state = 'failed';
    claim.failure_reason = 'kill_all';
    claim.finished_at = now;
    cancelledClaims++;
    cancelledRuns.push({ run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id });
  }

  let resetCount = 0;
  const changes: Record<string, { cause: 'operator_reset'; actorId: string; reason: string }> = {};
  for (const feature of backlog.features ?? []) {
    for (const task of feature.tasks ?? []) {
      if ((task.status === 'claimed' || task.status === 'in_progress') && !keptTaskRefs.has(task.ref)) {
        task.status = 'todo';
        delete task.blocked_reason;
        task.updated_at = now;
        changes[task.ref] = { cause: 'operator_reset', actorId: 'human', reason: 'kill_all' };
        resetCount++;
      }
    }
  }

  // runtime.db (task status) commits before events.db (run rows + events); reconcile repairs a crash between them.
  commitBacklog(STATE_DIR, backlog, changes);
  commitClaims(STATE_DIR, claimsState, [{
        ts: now,
        event: 'coordinator_stopped',
        actor_type: 'human',
        actor_id: 'human',
        payload: { tasks_reset: resetCount, claims_cancelled: cancelledClaims },
      }, ...cancelledRuns.map((run) => ({
        ts: now, event: 'run_cancelled' as const, actor_type: 'human' as const, actor_id: 'human',
        ...run, payload: { reason: 'kill_all' },
      }))]);

  console.log(`✓ Reset ${resetCount} in-flight task(s), cancelled ${cancelledClaims} claim(s)${keptRunIds.size ? `, kept ${keptRunIds.size} run(s) of kept sessions` : ''}`);
});

// ── Step 5: Remove all run worktrees ────────────────────────────────────────

if (existsSync(RUN_WORKTREES_FILE)) {
  let runs: Array<{ run_id: string }> = [];
  try {
    const parsed = JSON.parse(readFileSync(RUN_WORKTREES_FILE, 'utf8')) as { runs?: Array<{ run_id: string }> };
    runs = parsed.runs ?? [];
  } catch { /* stale or unreadable — skip */ }

  let removedWorktrees = 0;
  for (const entry of runs) {
    if (keptRunIds.has(entry.run_id)) continue;
    try {
      cleanupRunWorktree(STATE_DIR, entry.run_id);
      removedWorktrees++;
    } catch (e) {
      console.error(`  Warning: could not remove worktree for run ${entry.run_id}: ${formatErrorMessage(e)}`);
    }
  }

  // Clear the registry regardless of individual cleanup results; kept runs keep their entries.
  withLock(join(STATE_DIR, '.lock'), () => {
    atomicWriteJson(RUN_WORKTREES_FILE, { version: '1', runs: runs.filter((entry) => keptRunIds.has(entry.run_id)) });
  });
  console.log(`✓ Removed ${removedWorktrees} run worktree(s)`);
}
