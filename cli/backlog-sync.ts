#!/usr/bin/env node
/**
 * cli/backlog-sync.ts
 * Usage: orc backlog-sync
 *
 * Repair orchestrator backlog metadata from authoritative markdown task specs.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBacklogFromSpecs } from '../lib/backlogSync.ts';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';

export function formatBacklogRepairResult(result: {
  updated: boolean;
  added_tasks: number;
  updated_tasks: number;
  added_features: number;
}) {
  if (!result.updated) {
    return 'backlog sync OK: state already matched authoritative markdown specs';
  }
  return [
    'backlog sync repaired orchestrator state',
    `- added features: ${result.added_features}`,
    `- added tasks: ${result.added_tasks}`,
    `- updated tasks: ${result.updated_tasks}`,
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = syncBacklogFromSpecs(STATE_DIR, BACKLOG_DOCS_DIR);
    console.log(formatBacklogRepairResult(result));
  } catch (error) {
    console.error(`backlog sync FAILED: ${(error as Error).message}`);
    process.exit(1);
  }
}
