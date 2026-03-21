#!/usr/bin/env node
/**
 * cli/backlog-sync-check.ts
 * Usage: orc backlog-sync-check
 *
 * Verify that active backlog markdown specs and orchestrator state agree on
 * authoritative task metadata. Exits 1 if any spec refs are unregistered or
 * any authoritative metadata has drifted.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskStatus } from '../types/backlog.ts';
import { discoverActiveTaskSpecs, type SpecEntry } from '../lib/backlogSync.ts';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';

const ACTIVE_STATUSES = new Set<TaskStatus>(['claimed', 'in_progress']);

interface RegisteredTaskEntry {
  feature: string;
  task: Record<string, unknown>;
}

export interface BacklogSyncMismatch {
  file: string;
  ref: string;
  field: 'feature' | 'title' | 'status';
  expected: string;
  actual: string;
}

export function extractTaskSpecRefs(backlogDocsDir: string) {
  return discoverActiveTaskSpecs(backlogDocsDir).map(({ file, ref }) => ({ file, ref }));
}

export function extractRegisteredTaskRefs(stateBacklogPath: string) {
  const backlog = JSON.parse(readFileSync(stateBacklogPath, 'utf8')) as Record<string, unknown>;
  const epicsOrFeatures = ((backlog.epics ?? backlog.features ?? []) as Array<Record<string, unknown>>);
  return new Set(
    epicsOrFeatures.flatMap((container) =>
      ((container.tasks ?? []) as Array<Record<string, unknown>>)
        .map((task) => task.ref)
        .filter((ref): ref is string => typeof ref === 'string' && (ref).length > 0),
    ),
  );
}

function readRegisteredTaskEntries(stateBacklogPath: string): Map<string, RegisteredTaskEntry> {
  const backlog = JSON.parse(readFileSync(stateBacklogPath, 'utf8')) as Record<string, unknown>;
  const epicsOrFeatures = ((backlog.epics ?? backlog.features ?? []) as Array<Record<string, unknown>>);
  const entries = new Map<string, RegisteredTaskEntry>();
  for (const container of epicsOrFeatures) {
    const featureRef = typeof container.ref === 'string' ? container.ref : '';
    for (const task of ((container.tasks ?? []) as Array<Record<string, unknown>>)) {
      if (typeof task.ref !== 'string' || task.ref.length === 0) continue;
      entries.set(task.ref, { feature: featureRef, task });
    }
  }
  return entries;
}

function findMetadataMismatches(specs: SpecEntry[], registered: Map<string, RegisteredTaskEntry>): BacklogSyncMismatch[] {
  const mismatches: BacklogSyncMismatch[] = [];
  for (const spec of specs) {
    const entry = registered.get(spec.ref);
    if (!entry) continue;
    const actualStatus = typeof entry.task.status === 'string' ? entry.task.status : '';

    if (entry.feature !== spec.feature) {
      mismatches.push({
        file: spec.file,
        ref: spec.ref,
        field: 'feature',
        expected: spec.feature,
        actual: entry.feature,
      });
    }

    const actualTitle = typeof entry.task.title === 'string' ? entry.task.title : '';
    if (actualTitle !== spec.title) {
      mismatches.push({
        file: spec.file,
        ref: spec.ref,
        field: 'title',
        expected: spec.title,
        actual: actualTitle,
      });
    }

    if (!ACTIVE_STATUSES.has(actualStatus as TaskStatus) && actualStatus !== spec.status) {
      mismatches.push({
        file: spec.file,
        ref: spec.ref,
        field: 'status',
        expected: spec.status,
        actual: actualStatus,
      });
    }
  }
  return mismatches;
}

export function validateBacklogSync(
  backlogDocsDir: string,
  stateBacklogPath: string,
  filterRefs?: Set<string>,
) {
  let specs = discoverActiveTaskSpecs(backlogDocsDir);
  if (filterRefs !== undefined && filterRefs.size > 0) {
    specs = specs.filter((spec) => filterRefs.has(spec.ref));
  }
  const registeredRefs = extractRegisteredTaskRefs(stateBacklogPath);
  const registeredEntries = readRegisteredTaskEntries(stateBacklogPath);
  const missing = specs
    .filter((spec) => !registeredRefs.has(spec.ref))
    .map(({ file, ref }) => ({ file, ref }));
  const mismatches = findMetadataMismatches(specs, registeredEntries);
  return {
    ok: missing.length === 0 && mismatches.length === 0,
    spec_count: specs.length,
    filtered: filterRefs !== undefined && filterRefs.size > 0,
    missing,
    mismatches,
  };
}

export function formatBacklogSyncResult(result: {
  ok: boolean;
  spec_count: number;
  filtered?: boolean;
  missing: Array<{ file: string; ref: string }>;
  mismatches: BacklogSyncMismatch[];
}) {
  const scope = result.filtered
    ? `${result.spec_count} ref(s)`
    : `${result.spec_count} specs`;
  if (result.ok) {
    return `backlog sync OK: ${scope} matched orchestrator state`;
  }
  return [
    `backlog sync FAILED: ${result.missing.length} missing ref(s), ${result.mismatches.length} metadata mismatch(es)`,
    ...result.missing.map((entry) => `- ${entry.ref} (${entry.file})`),
    ...result.mismatches.map((entry) =>
      `- ${entry.ref} (${entry.file}): ${entry.field} expected "${entry.expected}" but found "${entry.actual}"`),
  ].join('\n');
}

const stateBacklogPath = join(STATE_DIR, 'backlog.json');

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const refsArg = process.argv.find((a) => a.startsWith('--refs='));
    const filterRefs = refsArg
      ? new Set(refsArg.slice('--refs='.length).split(',').map((r) => r.trim()).filter(Boolean))
      : undefined;
    const result = validateBacklogSync(BACKLOG_DOCS_DIR, stateBacklogPath, filterRefs);
    const output = formatBacklogSyncResult(result);
    if (!result.ok) {
      console.error(output);
      process.exit(1);
    }
    console.log(output);
  } catch (error) {
    console.error(`backlog sync FAILED: ${(error as Error).message}`);
    process.exit(1);
  }
}
