import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRepoRoot } from './repoRoot.ts';
import { findPlanById, parsePlan, type ParsedPlan } from './planDocs.ts';
import { planToBacklog, type PlanInput, type ProposedTask } from './planToBacklog.ts';

export interface SpecOptions {
  plansDir?: string;
  backlogDir?: string;
  stagingRoot?: string;
}

export interface SpecPreview {
  plan: { planId: number; name: string; title: string; path: string };
  startTaskNumber: number;
  tasks: ProposedTask[];
}

export interface SpecResult {
  plan: { planId: number; name: string; title: string; path: string };
  createdRefs: string[];
  createdFiles: string[];
  planPath: string;
}

const SPEC_FILE_RE = /^(\d+)([-.].+)?\.md$/;

function scanNextTaskNumber(backlogDir: string): number {
  if (!existsSync(backlogDir)) return 1;
  let max = 0;
  for (const name of readdirSync(backlogDir)) {
    const m = SPEC_FILE_RE.exec(name);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

function taskNumberFromRef(ref: string): number {
  const slug = ref.split('/').pop() ?? '';
  const m = /^(\d+)(?:-|$)/.exec(slug);
  if (!m) throw new Error(`publishSpec: cannot extract task number from ref: ${ref}`);
  return parseInt(m[1], 10);
}

function formatDependencyLine(dependsOn: string[]): string {
  if (dependsOn.length === 0) return 'Independent.';
  const nums = dependsOn.map(taskNumberFromRef);
  if (nums.length === 1) return `Depends on Task ${nums[0]}.`;
  const head = nums.slice(0, -1).join(', ');
  const tail = nums[nums.length - 1];
  return `Depends on Tasks ${head}, and ${tail}.`;
}

function renderTaskSpec(task: ProposedTask, taskNumber: number): string {
  const frontmatterLines = [
    '---',
    `ref: ${task.ref}`,
    `feature: ${task.feature}`,
    `review_level: ${task.reviewLevel}`,
    'priority: normal',
    'status: todo',
  ];
  if (task.dependsOn.length > 0) {
    frontmatterLines.push('depends_on:');
    for (const dep of task.dependsOn) frontmatterLines.push(`  - ${dep}`);
  }
  frontmatterLines.push('---', '');

  const body = [
    `# Task ${taskNumber} — ${task.title}`,
    '',
    formatDependencyLine(task.dependsOn),
    '',
    '## Scope',
    '',
    task.description,
    '',
    '---',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] Implementation matches the plan step.',
    '- [ ] No changes to files outside the stated scope.',
    '',
    '---',
    '',
    '## Verification',
    '',
    '```bash',
    'nvm use 24 && npm test',
    '```',
    '',
  ];

  return [...frontmatterLines, ...body].join('\n');
}

function buildPlanInput(plan: ParsedPlan, startTaskNumber: number): PlanInput {
  return {
    name: plan.name,
    title: plan.title,
    startTaskNumber,
    steps: plan.steps.map((step) => ({
      number: step.number,
      title: step.title,
      body: step.body,
      ...(step.dependsOn.length > 0 ? { dependsOn: step.dependsOn } : {}),
    })),
  };
}

function defaultStateDir(): string {
  return process.env.ORC_STATE_DIR
    ? resolve(process.env.ORC_STATE_DIR)
    : resolve(resolveRepoRoot(), '.orc-state');
}

function defaultPlansDir(): string {
  return process.env.ORC_PLANS_DIR
    ? resolve(process.env.ORC_PLANS_DIR)
    : resolve(resolveRepoRoot(), 'plans');
}

function defaultBacklogDir(): string {
  return process.env.ORC_BACKLOG_DIR
    ? resolve(process.env.ORC_BACKLOG_DIR)
    : resolve(resolveRepoRoot(), 'backlog');
}

function resolveDirs(opts: SpecOptions): { plansDir: string; backlogDir: string; stagingRoot: string } {
  return {
    plansDir: opts.plansDir ?? defaultPlansDir(),
    backlogDir: opts.backlogDir ?? defaultBacklogDir(),
    stagingRoot: opts.stagingRoot ?? join(defaultStateDir(), 'plan-staging'),
  };
}

export function previewSpec(planId: number, opts: SpecOptions = {}): SpecPreview {
  if (!Number.isInteger(planId) || planId < 0) {
    throw new Error(`previewSpec: plan_id must be a non-negative integer, got ${planId}`);
  }
  const { plansDir, backlogDir } = resolveDirs(opts);
  const planPath = findPlanById(planId, plansDir);
  const plan = parsePlan(planPath);
  const startTaskNumber = scanNextTaskNumber(backlogDir);
  const tasks = planToBacklog(buildPlanInput(plan, startTaskNumber));
  return {
    plan: { planId: plan.planId, name: plan.name, title: plan.title, path: plan.path },
    startTaskNumber,
    tasks,
  };
}

function updatePlanDerivedRefs(planPath: string, refs: string[]): void {
  const text = readFileSync(planPath, 'utf8');
  const match = /^(---\s*\n)([\s\S]*?)(\n---)/.exec(text);
  if (!match) {
    throw new Error(`publishSpec: plan file has no frontmatter: ${planPath}`);
  }
  const body = text.slice(match[0].length);
  const lines = match[2].split('\n');
  const idx = lines.findIndex((line) => /^derived_task_refs\s*:/.test(line));
  if (idx === -1) {
    throw new Error(`publishSpec: plan file missing derived_task_refs: ${planPath}`);
  }

  let trailingListLines = 0;
  const afterStart = idx + 1;
  if (!/\[/.test(lines[idx])) {
    for (let i = afterStart; i < lines.length; i += 1) {
      if (/^\s+-\s+/.test(lines[i])) trailingListLines += 1;
      else break;
    }
  }

  const before = lines.slice(0, idx);
  const after = lines.slice(afterStart + trailingListLines);
  const rewritten: string[] = [];
  if (refs.length === 0) {
    rewritten.push('derived_task_refs: []');
  } else {
    rewritten.push('derived_task_refs:');
    for (const ref of refs) rewritten.push(`  - ${ref}`);
  }

  const newFrontmatter = [...before, ...rewritten, ...after].join('\n');
  const newContent = `${match[1]}${newFrontmatter}\n---${body}`;
  const tmp = `${planPath}.tmp`;
  writeFileSync(tmp, newContent, 'utf8');
  renameSync(tmp, planPath);
}

export function publishSpec(
  planId: number,
  opts: SpecOptions & { confirm: true },
): SpecResult {
  if (opts?.confirm !== true) {
    throw new Error('publishSpec: confirm must be true to publish');
  }
  if (!Number.isInteger(planId) || planId < 0) {
    throw new Error(`publishSpec: plan_id must be a non-negative integer, got ${planId}`);
  }

  const { plansDir, backlogDir, stagingRoot } = resolveDirs(opts);
  const planPath = findPlanById(planId, plansDir);
  const plan = parsePlan(planPath);

  if (plan.derivedTaskRefs.length > 0) {
    throw new Error(
      `publishSpec: plan ${planId} already has derived_task_refs (${plan.derivedTaskRefs.join(', ')}). Regeneration is not supported; create a new plan instead.`,
    );
  }

  mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = join(stagingRoot, String(planId));
  try {
    mkdirSync(stagingDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `publishSpec: staging directory already exists for plan ${planId} (${stagingDir}). Another publish may be in progress, or a prior run left stale state. Remove it manually if no publish is active.`,
      );
    }
    throw err;
  }

  const startTaskNumber = scanNextTaskNumber(backlogDir);
  const tasks = planToBacklog(buildPlanInput(plan, startTaskNumber));

  const staged: Array<{ stagedPath: string; finalPath: string; ref: string }> = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    const taskNumber = startTaskNumber + i;
    const filename = `${task.slug}.md`;
    const stagedPath = join(stagingDir, filename);
    const finalPath = join(backlogDir, filename);
    const content = renderTaskSpec(task, taskNumber);
    writeFileSync(stagedPath, content, 'utf8');
    staged.push({ stagedPath, finalPath, ref: task.ref });
  }

  mkdirSync(backlogDir, { recursive: true });
  const createdRefs: string[] = [];
  const createdFiles: string[] = [];
  try {
    for (const entry of staged) {
      if (existsSync(entry.finalPath)) {
        throw new Error(`backlog file already exists: ${entry.finalPath}`);
      }
      renameSync(entry.stagedPath, entry.finalPath);
      createdFiles.push(entry.finalPath);
      createdRefs.push(entry.ref);
    }
    updatePlanDerivedRefs(planPath, createdRefs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const visible = createdRefs.length > 0
      ? ` Visible refs in backlog: ${createdRefs.join(', ')}. derived_task_refs was NOT updated.`
      : '';
    throw new Error(`publishSpec: publication failed: ${message}.${visible}`);
  }

  rmSync(stagingDir, { recursive: true, force: true });

  return {
    plan: { planId: plan.planId, name: plan.name, title: plan.title, path: plan.path },
    createdRefs,
    createdFiles,
    planPath,
  };
}
