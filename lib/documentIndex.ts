import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { parseTaskSpecEntry } from './backlogSync.ts';
import { parsePlan } from './planDocs.ts';
import { scanForInjection } from './promptInjectionScan.ts';
import { InjectionScanError } from './taskSpecReader.ts';
import type { TaskSpecSnapshot } from '../types/claims.ts';
import { readClaims } from './stateReader.ts';
import { projectTaskStoreFor } from './projectTasks.ts';
import type { TaskSpecRevision } from './projectTaskStore.ts';

export interface DocumentIndexEntry {
  kind: 'task' | 'plan';
  path: string;
  ref: string | null;
  sha256: string;
  valid: boolean;
  error?: string;
}

export interface DocumentIndex {
  version: '1';
  entries: DocumentIndexEntry[];
}

export function documentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function markdownFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((relativePath) => pattern.test(basename(relativePath)) && !relativePath.startsWith('legacy/'))
    .sort();
}

/** Rebuildable cache. Run snapshots live separately and are never rewritten here. */
export function rebuildDocumentIndex(stateDir: string, docsDir: string, plansDir: string): DocumentIndex {
  const entries: DocumentIndexEntry[] = [];
  for (const relativePath of markdownFiles(docsDir, /^\d+([-.].+)?\.md$/)) {
    const content = readFileSync(join(docsDir, relativePath), 'utf8');
    const scan = scanForInjection(content);
    let ref: string | null = null;
    let error: string | undefined;
    try {
      const spec = parseTaskSpecEntry(content, relativePath);
      ref = spec?.ref ?? null;
      if (!spec) error = 'invalid or incomplete task frontmatter';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'invalid task spec';
    }
    if (!scan.safe) error = 'injection scan failed';
    entries.push({
      kind: 'task', path: join(docsDir, relativePath), ref,
      sha256: documentHash(content), valid: !error,
      ...(error ? { error } : {}),
    });
  }
  for (const relativePath of markdownFiles(plansDir, /^\d+-[^/]+\.md$/)) {
    const path = join(plansDir, relativePath);
    const content = readFileSync(path, 'utf8');
    try {
      const plan = parsePlan(path);
      entries.push({ kind: 'plan', path, ref: String(plan.planId), sha256: documentHash(content), valid: true });
    } catch (error) {
      entries.push({ kind: 'plan', path, ref: null, sha256: documentHash(content), valid: false,
        error: error instanceof Error ? error.message : 'invalid plan' });
    }
  }
  const index: DocumentIndex = { version: '1', entries };
  atomicWriteJson(join(stateDir, 'document-index.json'), index);
  return index;
}

export function readTaskDocument(taskRef: string, docsDir: string): { path: string; content: string; sha256: string } {
  const matches = markdownFiles(docsDir, /^\d+([-.].+)?\.md$/).flatMap((relativePath) => {
    const content = readFileSync(join(docsDir, relativePath), 'utf8');
    try {
      const spec = parseTaskSpecEntry(content, relativePath);
      return spec?.ref === taskRef ? [spec] : [];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1) throw new Error(`Expected one valid Markdown spec for ${taskRef}; found ${matches.length}`);
  const path = join(docsDir, matches[0].file);
  const content = matches[0].content;
  const scan = scanForInjection(content);
  if (!scan.safe) throw new InjectionScanError(scan.findings);
  return { path, content, sha256: documentHash(content) };
}

export function writeRunTaskSnapshot(stateDir: string, runId: string, taskRef: string, docsDir: string): TaskSpecSnapshot {
  const source = readTaskDocument(taskRef, docsDir);
  const directory = join(stateDir, 'run-specs');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${runId}.md`);
  writeFileSync(path, source.content, { flag: 'wx' });
  chmodSync(path, 0o444);
  return { source_path: source.path, snapshot_path: path, sha256: source.sha256 };
}

/** Write the exact body of a pinned project revision as the run's read-only spec. */
export function writeRunRevisionSnapshot(stateDir: string, runId: string, revision: TaskSpecRevision): TaskSpecSnapshot {
  const scan = scanForInjection(revision.bodyMarkdown);
  if (!scan.safe) throw new InjectionScanError(scan.findings);
  const directory = join(stateDir, 'run-specs');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${runId}.md`);
  writeFileSync(path, revision.bodyMarkdown, { flag: 'wx' });
  chmodSync(path, 0o444);
  return {
    source_path: `project-task:${revision.taskRef}@${revision.revision}`,
    snapshot_path: path, sha256: documentHash(revision.bodyMarkdown), task_revision: revision.revision,
  };
}

/** A pinned project revision is stale once a newer revision exists; a file source once its content changes. */
export function taskSnapshotStatus(snapshot: TaskSpecSnapshot, stateDir?: string): 'current' | 'stale' | 'missing' {
  if (snapshot.task_revision !== undefined) {
    const taskRef = snapshot.source_path.replace(/^project-task:/, '').replace(/@\d+$/, '');
    const latest = stateDir ? projectTaskStoreFor(stateDir)?.getTask(taskRef) : null;
    if (!latest) return 'missing';
    return latest.revision === snapshot.task_revision ? 'current' : 'stale';
  }
  if (!existsSync(snapshot.source_path)) return 'missing';
  return documentHash(readFileSync(snapshot.source_path, 'utf8')) === snapshot.sha256 ? 'current' : 'stale';
}

export function verifyRunTaskSnapshot(snapshot: TaskSpecSnapshot): void {
  if (documentHash(readFileSync(snapshot.snapshot_path, 'utf8')) !== snapshot.sha256) {
    throw new Error(`Run task snapshot hash mismatch: ${snapshot.snapshot_path}`);
  }
}

/** Remove only snapshots that have no claim record, including crash leftovers. */
export function pruneOrphanRunTaskSnapshots(stateDir: string): number {
  const directory = join(stateDir, 'run-specs');
  if (!existsSync(directory)) return 0;
  const claims = readClaims(stateDir);
  const known = new Set(claims.claims.map((claim) => claim.run_id));
  let removed = 0;
  for (const file of readdirSync(directory)) {
    if (!/^run-[A-Za-z0-9-]+\.md$/.test(file) || known.has(file.slice(0, -3))) continue;
    unlinkSync(join(directory, file));
    removed += 1;
  }
  return removed;
}
