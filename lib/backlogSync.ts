import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { withLock } from './lock.ts';
import type { Backlog, Feature, Task, TaskStatus } from '../types/backlog.ts';

const SPEC_FILE_RE = /^\d+-.+\.md$/;
const ACTIVE_STATUSES = new Set<TaskStatus>(['claimed', 'in_progress']);
const VALID_SPEC_STATUSES = new Set<string>(['todo', 'blocked', 'done', 'released']);

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface SpecFrontmatter {
  ref: string | null;
  feature: string | null;
  status: string | null;
}

function parseSpecFrontmatter(text: string): SpecFrontmatter {
  const block = text.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
  return {
    ref: block.match(/^ref:\s+(.+)$/m)?.[1]?.trim() ?? null,
    feature: (block.match(/^feature:\s+(.+)$/m)?.[1] ?? block.match(/^epic:\s+(.+)$/m)?.[1])?.trim() ?? null,
    status: block.match(/^status:\s+(.+)$/m)?.[1]?.trim() ?? null,
  };
}

function parseSpecTitle(text: string, ref: string | null): string {
  const heading = text.match(/^#\s+Task\s+\d+\s+[—-]\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return ref?.split('/')[1] ? humanizeSlug(ref.split('/')[1]) : (ref ?? '');
}

interface SpecEntry {
  ref: string;
  feature: string;
  status: string;
  title: string;
}

function readSpecs(docsDir: string): SpecEntry[] {
  return readdirSync(docsDir)
    .filter((name) => SPEC_FILE_RE.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .flatMap((name) => {
      const text = readFileSync(join(docsDir, name), 'utf8');
      const { ref, feature, status } = parseSpecFrontmatter(text);
      if (!ref || !feature || !status || !VALID_SPEC_STATUSES.has(status)) return [];
      return [{
        ref,
        feature,
        status,
        title: parseSpecTitle(text, ref),
      }];
    });
}

function findTaskEntry(backlog: Backlog, taskRef: string): { feature: Feature; task: Task } | null {
  for (const feature of (backlog.features ?? [])) {
    const task = (feature.tasks ?? []).find((entry) => entry.ref === taskRef);
    if (task) return { feature, task };
  }
  return null;
}

function removeTaskFromFeature(feature: Feature, taskRef: string): void {
  feature.tasks = (feature.tasks ?? []).filter((entry) => entry.ref !== taskRef);
}

function ensureFeature(backlog: Backlog, featureRef: string): { feature: Feature; created: boolean } {
  let feature = (backlog.features ?? []).find((entry) => entry.ref === featureRef) ?? null;
  if (feature) return { feature, created: false };

  feature = {
    ref: featureRef,
    title: humanizeSlug(featureRef),
    tasks: [],
  };
  backlog.features = [...(backlog.features ?? []), feature];
  return { feature, created: true };
}

export interface SyncResult {
  updated: boolean;
  added_tasks: number;
  updated_tasks: number;
  added_features: number;
}

export function syncBacklogFromSpecs(stateDir: string, docsDir: string): SyncResult {
  const specs = readSpecs(docsDir);
  if (specs.length === 0) {
    return { updated: false, added_tasks: 0, updated_tasks: 0, added_features: 0 };
  }

  const backlogPath = join(stateDir, 'backlog.json');

  return withLock(join(stateDir, '.lock'), () => {
    const backlog = JSON.parse(readFileSync(backlogPath, 'utf8')) as Backlog;
    let changed = false;
    let addedTasks = 0;
    let updatedTasks = 0;
    let addedFeatures = 0;

    for (const spec of specs) {
      const ensured = ensureFeature(backlog, spec.feature);
      if (ensured.created) {
        changed = true;
        addedFeatures += 1;
      }

      const existingEntry = findTaskEntry(backlog, spec.ref);
      if (!existingEntry) {
        ensured.feature.tasks = [
          ...(ensured.feature.tasks ?? []),
          {
            ref: spec.ref,
            title: spec.title,
            status: spec.status as TaskStatus,
            task_type: 'implementation',
          },
        ];
        changed = true;
        addedTasks += 1;
        continue;
      }

      if (existingEntry.feature.ref !== spec.feature && !ACTIVE_STATUSES.has(existingEntry.task.status)) {
        removeTaskFromFeature(existingEntry.feature, spec.ref);
        ensured.feature.tasks = [...(ensured.feature.tasks ?? []), existingEntry.task];
        changed = true;
      }

      if (ACTIVE_STATUSES.has(existingEntry.task.status)) continue;
      if (existingEntry.task.status === spec.status) continue;

      existingEntry.task.status = spec.status as TaskStatus;
      changed = true;
      updatedTasks += 1;
    }

    if (changed) {
      atomicWriteJson(backlogPath, backlog);
    }

    return {
      updated: changed,
      added_tasks: addedTasks,
      updated_tasks: updatedTasks,
      added_features: addedFeatures,
    };
  });
}
