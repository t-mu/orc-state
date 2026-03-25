#!/usr/bin/env node
/**
 * cli/backlog-orient.ts
 * Usage: orc backlog-orient
 *
 * Prints everything an agent needs before creating backlog tasks:
 *   - next available task number
 *   - list of features with task counts
 *   - backlog docs directory path
 *
 * Output is plain text, machine-parseable line by line.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, BACKLOG_DOCS_DIR } from '../lib/paths.ts';

const asJson = process.argv.includes('--json');

const backlogPath = join(STATE_DIR, 'backlog.json');

if (!existsSync(backlogPath)) {
  console.error('backlog state not found — run: orc init');
  process.exit(1);
}

const backlog = JSON.parse(readFileSync(backlogPath, 'utf8')) as {
  features?: Array<{ ref: string; title: string; tasks: Array<{ ref: string; status: string }> }>;
  next_task_seq?: number;
};

const features = backlog.features ?? [];
const allTasks = features.flatMap((e) => e.tasks ?? []);

// next_task_seq: use stored value, or derive from max seq number in refs, or default to 1
let nextSeq: number = backlog.next_task_seq ?? 1;
for (const task of allTasks) {
  const m = task.ref.match(/\/(\d+)-/);
  if (m) nextSeq = Math.max(nextSeq, Number(m[1]) + 1);
}

// Ensure backlog docs dir exists
if (!existsSync(BACKLOG_DOCS_DIR)) {
  mkdirSync(BACKLOG_DOCS_DIR, { recursive: true });
}

if (asJson) {
  const featureData = features.map((feature) => {
    const tasks = feature.tasks ?? [];
    const todo = tasks.filter((t) => t.status === 'todo').length;
    const done = tasks.filter((t) => t.status === 'done' || t.status === 'released').length;
    const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
    const active = tasks.filter((t) => t.status === 'claimed' || t.status === 'in_progress').length;
    return {
      ref: feature.ref,
      title: feature.title,
      task_counts: { total: tasks.length, todo, active, done, cancelled },
    };
  });
  console.log(JSON.stringify({
    next_task_seq: nextSeq,
    backlog_docs_dir: BACKLOG_DOCS_DIR,
    features: featureData,
  }, null, 2));
  process.exit(0);
}

console.log(`next_task_seq: ${nextSeq}`);
console.log(`backlog_docs_dir: ${BACKLOG_DOCS_DIR}`);
console.log(`features (${features.length}):`);

for (const feature of features) {
  const tasks = feature.tasks ?? [];
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'released').length;
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const active = tasks.filter((t) => t.status === 'claimed' || t.status === 'in_progress').length;
  console.log(`  ${feature.ref} — ${feature.title} (${tasks.length} tasks: ${todo} todo, ${active} active, ${done} done, ${cancelled} cancelled)`);
}
