#!/usr/bin/env node
/**
 * cli/gc-workers.ts
 * Usage: node cli/gc-workers.ts [--json]
 *
 * Removes offline and dead worker records. A running coordinator removes these
 * itself (along with workers whose session exited), so this covers the case
 * where no coordinator is running.
 * A worker that holds an active claim is kept: the coordinator recovers its run.
 * The claim and status checks run under the state lock that removes each worker,
 * so a claim the coordinator creates concurrently is never orphaned.
 * The master and scouts are never touched (scouts are removed with remove_scout).
 * It also removes pty-hook-events/ files whose agent is no longer registered.
 */
import { listAgents, removeUnclaimedAgent } from '../lib/agentRegistry.ts';
import { gcOrphanedHookFiles } from '../lib/hookFiles.ts';
import { assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { boolFlag } from '../lib/args.ts';
import { failCommand, printJson } from './shared.ts';

const json = boolFlag('json');

try {
  assertProjectMode();
} catch (error) {
  await failCommand(error, json);
}

const isGone = (status: string) => status === 'offline' || status === 'dead';
let removed = 0;

for (const worker of listAgents(STATE_DIR)) {
  if (worker.role === 'master' || worker.role === 'scout' || !isGone(worker.status)) continue;
  if (removeUnclaimedAgent(STATE_DIR, worker.agent_id, (agent) => isGone(agent.status)).removed) removed++;
}

const hookFiles = gcOrphanedHookFiles(STATE_DIR, listAgents(STATE_DIR).map((agent) => agent.agent_id));

if (json) printJson({ removed_workers: removed, removed_hook_files: hookFiles.length });
else console.log(`Worker GC complete. Removed ${removed} worker(s) and ${hookFiles.length} orphaned hook-event file(s).`);
