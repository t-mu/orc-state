#!/usr/bin/env node
/**
 * cli/backlog-sync-check.ts
 * Usage: orc backlog-sync-check
 *
 * Verify that active backlog markdown specs and orchestrator state agree on
 * task definitions (feature, title) in a legacy installation. Exits 1 if any
 * todo spec is unregistered or a definition has drifted. Status is
 * runtime-owned and is not compared; a non-todo spec that was never
 * registered is listed as skipped (migrate the installation to carry it).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverActiveTaskSpecs, type SpecEntry } from '../lib/backlogSync.ts';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';
import { formatErrorMessage } from './shared.ts';

interface RegisteredTaskEntry {
  feature: string;
  task: Record<string, unknown>;
}

export interface BacklogSyncMismatch {
  file: string;
  ref: string;
  field: 'feature' | 'title';
  expected: string;
  actual: string;
}

export function extractTaskSpecRefs(backlogDocsDir: string) {
  return discoverActiveTaskSpecs(backlogDocsDir).map(({ file, ref }) => ({ file, ref }));
}

export function extractRegisteredTaskRefs(stateBacklogPath: string) {
  const backlog = JSON.parse(readFileSync(stateBacklogPath, 'utf8')) as Record<string, unknown>;
  const featuresCompat = ((backlog.epics ?? backlog.features ?? []) as Array<Record<string, unknown>>);
  return new Set(
    featuresCompat.flatMap((container) =>
      ((container.tasks ?? []) as Array<Record<string, unknown>>)
        .map((task) => task.ref)
        .filter((ref): ref is string => typeof ref === 'string' && (ref).length > 0),
    ),
  );
}

function readRegisteredTaskEntries(stateBacklogPath: string): Map<string, RegisteredTaskEntry> {
  const backlog = JSON.parse(readFileSync(stateBacklogPath, 'utf8')) as Record<string, unknown>;
  const featuresCompat = ((backlog.epics ?? backlog.features ?? []) as Array<Record<string, unknown>>);
  const entries = new Map<string, RegisteredTaskEntry>();
  for (const container of featuresCompat) {
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
  const unregistered = specs.filter((spec) => !registeredRefs.has(spec.ref));
  // Sync registers only todo specs; the others need a migration, not a re-sync.
  const missing = unregistered.filter((spec) => spec.status === 'todo').map(({ file, ref }) => ({ file, ref }));
  const skipped = unregistered.filter((spec) => spec.status !== 'todo').map(({ file, ref, status }) => ({ file, ref, status }));
  const mismatches = findMetadataMismatches(specs, registeredEntries);
  return {
    ok: missing.length === 0 && mismatches.length === 0,
    spec_count: specs.length,
    filtered: filterRefs !== undefined && filterRefs.size > 0,
    missing,
    mismatches,
    skipped,
  };
}

export function formatBacklogSyncResult(result: {
  ok: boolean;
  spec_count: number;
  filtered?: boolean;
  missing: Array<{ file: string; ref: string }>;
  mismatches: BacklogSyncMismatch[];
  skipped?: Array<{ file: string; ref: string; status: string }>;
}) {
  const scope = result.filtered
    ? `${result.spec_count} ref(s)`
    : `${result.spec_count} specs`;
  const skipped = (result.skipped ?? []).length > 0
    ? [`${result.skipped!.length} unregistered non-todo spec(s) skipped; run orc project migrate to carry their status:`,
      ...result.skipped!.map((entry) => `- ${entry.ref} (${entry.file}): status ${entry.status}`)]
    : [];
  if (result.ok) {
    return [`backlog sync OK: ${scope} matched orchestrator state`, ...skipped].join('\n');
  }
  return [
    `backlog sync FAILED: ${result.missing.length} missing ref(s), ${result.mismatches.length} metadata mismatch(es)`,
    ...result.missing.map((entry) => `- ${entry.ref} (${entry.file})`),
    ...result.mismatches.map((entry) =>
      `- ${entry.ref} (${entry.file}): ${entry.field} expected "${entry.expected}" but found "${entry.actual}"`),
    ...skipped,
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
    console.error(`backlog sync FAILED: ${formatErrorMessage(error)}`);
    process.exit(1);
  }
}
