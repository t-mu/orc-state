import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.mjs';
import { withLock } from './lock.mjs';

const SPEC_FILE_RE = /^\d+-.+\.md$/;
const ACTIVE_STATUSES = new Set(['claimed', 'in_progress']);
const VALID_SPEC_STATUSES = new Set(['todo', 'blocked', 'done', 'released']);

function humanizeSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseSpecFrontmatter(text) {
  const block = text.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
  return {
    ref: block.match(/^ref:\s+(.+)$/m)?.[1]?.trim() ?? null,
    epic: block.match(/^epic:\s+(.+)$/m)?.[1]?.trim() ?? null,
    status: block.match(/^status:\s+(.+)$/m)?.[1]?.trim() ?? null,
  };
}

function parseSpecTitle(text, ref) {
  const heading = text.match(/^#\s+Task\s+\d+\s+[—-]\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return ref?.split('/')[1] ? humanizeSlug(ref.split('/')[1]) : ref;
}

function readSpecs(docsDir) {
  return readdirSync(docsDir)
    .filter((name) => SPEC_FILE_RE.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .flatMap((name) => {
      const text = readFileSync(join(docsDir, name), 'utf8');
      const { ref, epic, status } = parseSpecFrontmatter(text);
      if (!ref || !epic || !status || !VALID_SPEC_STATUSES.has(status)) return [];
      return [{
        ref,
        epic,
        status,
        title: parseSpecTitle(text, ref),
      }];
    });
}

function findTaskEntry(backlog, taskRef) {
  for (const epic of (backlog.epics ?? [])) {
    const task = (epic.tasks ?? []).find((entry) => entry.ref === taskRef);
    if (task) return { epic, task };
  }
  return null;
}

function removeTaskFromEpic(epic, taskRef) {
  epic.tasks = (epic.tasks ?? []).filter((entry) => entry.ref !== taskRef);
}

function ensureEpic(backlog, epicRef) {
  let epic = (backlog.epics ?? []).find((entry) => entry.ref === epicRef) ?? null;
  if (epic) return { epic, created: false };

  epic = {
    ref: epicRef,
    title: humanizeSlug(epicRef),
    tasks: [],
  };
  backlog.epics = [...(backlog.epics ?? []), epic];
  return { epic, created: true };
}

export function syncBacklogFromSpecs(stateDir, docsDir) {
  const specs = readSpecs(docsDir);
  if (specs.length === 0) {
    return { updated: false, added_tasks: 0, updated_tasks: 0, added_epics: 0 };
  }

  const backlogPath = join(stateDir, 'backlog.json');

  return withLock(join(stateDir, '.lock'), () => {
    const backlog = JSON.parse(readFileSync(backlogPath, 'utf8'));
    let changed = false;
    let addedTasks = 0;
    let updatedTasks = 0;
    let addedEpics = 0;

    for (const spec of specs) {
      const ensured = ensureEpic(backlog, spec.epic);
      if (ensured.created) {
        changed = true;
        addedEpics += 1;
      }

      const existingEntry = findTaskEntry(backlog, spec.ref);
      if (!existingEntry) {
        ensured.epic.tasks = [
          ...(ensured.epic.tasks ?? []),
          {
            ref: spec.ref,
            title: spec.title,
            status: spec.status,
            task_type: 'implementation',
          },
        ];
        changed = true;
        addedTasks += 1;
        continue;
      }

      if (existingEntry.epic.ref !== spec.epic && !ACTIVE_STATUSES.has(existingEntry.task.status)) {
        removeTaskFromEpic(existingEntry.epic, spec.ref);
        ensured.epic.tasks = [...(ensured.epic.tasks ?? []), existingEntry.task];
        changed = true;
      }

      if (ACTIVE_STATUSES.has(existingEntry.task.status)) continue;
      if (existingEntry.task.status === spec.status) continue;

      existingEntry.task.status = spec.status;
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
      added_epics: addedEpics,
    };
  });
}
