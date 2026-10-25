#!/usr/bin/env node
/**
 * cli/backlog-sync.ts
 * Usage: orc backlog-sync
 *
 * Register legacy task spec definitions (new todo specs, titles, dependencies)
 * into orchestrator state. Status is runtime-owned and never read from a spec.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBacklogFromSpecs } from '../lib/backlogSync.ts';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';
import { formatErrorMessage } from './shared.ts';
import { formatSkippedSpecs } from './backlog-sync-check.ts';

export function formatBacklogRepairResult(result: {
  updated: boolean;
  added_tasks: number;
  updated_tasks: number;
  added_features: number;
  skipped_specs?: Array<{ ref: string; status: string }>;
}) {
  const skipped = formatSkippedSpecs(result.skipped_specs ?? []);
  if (!result.updated) {
    return ['backlog sync OK: state already matched the spec definitions', ...skipped].join('\n');
  }
  return [
    'backlog sync repaired orchestrator state',
    `- added features: ${result.added_features}`,
    `- added tasks: ${result.added_tasks}`,
    `- updated tasks: ${result.updated_tasks}`,
    ...skipped,
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = syncBacklogFromSpecs(STATE_DIR, BACKLOG_DOCS_DIR);
    console.log(formatBacklogRepairResult(result));
  } catch (error) {
    console.error(`backlog sync FAILED: ${formatErrorMessage(error)}`);
    process.exit(1);
  }
}
