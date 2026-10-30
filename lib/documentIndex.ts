import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InjectionScanError, scanForInjection } from './promptInjectionScan.ts';
import type { TaskSpecSnapshot } from '../types/claims.ts';
import { readClaims } from './stateReader.ts';
import { projectTaskStoreFor } from './projectTasks.ts';
import type { TaskSpecRevision } from './projectTaskStore.ts';

export function documentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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
