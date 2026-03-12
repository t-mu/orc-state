#!/usr/bin/env node
/**
 * cli/backlog-sync-check.mjs
 * Usage: orc backlog-sync-check
 *
 * Verify that every task spec in the backlog docs directory has a matching
 * entry in orchestrator state. Exits 1 if any spec refs are unregistered.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKLOG_DOCS_DIR, STATE_DIR } from '../lib/paths.mjs';

const SPEC_FILE_RE = /^\d+(-[^.]+)?\.md$/;

export function extractTaskSpecRefs(backlogDocsDir) {
  return readdirSync(backlogDocsDir, { recursive: true })
    .filter((rel) => SPEC_FILE_RE.test(basename(rel)))
    .sort((a, b) => basename(a).localeCompare(basename(b), 'en', { numeric: true }))
    .flatMap((rel) => {
      const text = readFileSync(join(backlogDocsDir, rel), 'utf8');
      const refMatch = text.match(/^ref:\s+(.+)$/m);
      if (!refMatch) return [];
      return [{ file: rel, ref: refMatch[1].trim() }];
    });
}

export function extractRegisteredTaskRefs(stateBacklogPath) {
  const backlog = JSON.parse(readFileSync(stateBacklogPath, 'utf8'));
  return new Set(
    (backlog.epics ?? backlog.features ?? []).flatMap((container) =>
      (container.tasks ?? [])
        .map((task) => task.ref)
        .filter((ref) => typeof ref === 'string' && ref.length > 0),
    ),
  );
}

export function validateBacklogSync(backlogDocsDir, stateBacklogPath) {
  const specs = extractTaskSpecRefs(backlogDocsDir);
  const registered = extractRegisteredTaskRefs(stateBacklogPath);
  const missing = specs.filter((spec) => !registered.has(spec.ref));
  return {
    ok: missing.length === 0,
    spec_count: specs.length,
    missing,
  };
}

export function formatBacklogSyncResult(result) {
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
    console.error(`backlog sync FAILED: ${error.message}`);
    process.exit(1);
  }
}
