#!/usr/bin/env node
/**
 * cli/backlog-sync-check.ts
 * Usage: orc backlog-sync-check
 *
 * Verify that every task spec in the backlog docs directory has a matching
 * entry in orchestrator state. Exits 1 if any spec refs are unregistered.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.ts';

const SPEC_FILE_RE = /^\d+(-[^.]+)?\.md$/;

export function extractTaskSpecRefs(backlogDocsDir: string) {
  return readdirSync(backlogDocsDir, { recursive: true })
    .filter((rel) => SPEC_FILE_RE.test(basename(rel as string)))
    .sort((a, b) => basename(a as string).localeCompare(basename(b as string), 'en', { numeric: true }))
    .flatMap((rel) => {
      const text = readFileSync(join(backlogDocsDir, rel as string), 'utf8');
      const refMatch = text.match(/^ref:\s+(.+)$/m);
      if (!refMatch) return [];
      return [{ file: rel as string, ref: refMatch[1].trim() }];
    });
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

export function validateBacklogSync(backlogDocsDir: string, stateBacklogPath: string) {
  const specs = extractTaskSpecRefs(backlogDocsDir);
  const registered = extractRegisteredTaskRefs(stateBacklogPath);
  const missing = specs.filter((spec) => !registered.has(spec.ref));
  return {
    ok: missing.length === 0,
    spec_count: specs.length,
    missing,
  };
}

export function formatBacklogSyncResult(result: { ok: boolean; spec_count: number; missing: Array<{ file: string; ref: string }> }) {
  if (result.ok) {
    return `backlog sync OK: ${result.spec_count} specs matched orchestrator state`;
  }
  return [
    `backlog sync FAILED: ${result.missing.length} missing ref(s)`,
    ...result.missing.map((entry) => `- ${entry.ref} (${entry.file})`),
  ].join('\n');
}

const stateBacklogPath = join(STATE_DIR, 'backlog.json');

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = validateBacklogSync(BACKLOG_DOCS_DIR, stateBacklogPath);
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
