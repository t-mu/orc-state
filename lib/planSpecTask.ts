import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRepoRoot } from './repoRoot.ts';
import { findPlanById, parsePlan, type ParsedPlan } from './planDocs.ts';
import { planToBacklog, type PlanInput, type ProposedTask } from './planToBacklog.ts';

export interface SpecOptions {
  /** Explicit plans directory override. Precedence: highest. */
  plansDir?: string;
  /** Explicit backlog directory override. Precedence: highest. */
  backlogDir?: string;
  /** Explicit staging root override (replaces <stateDir>/plan-staging). */
  stagingRoot?: string;
  /** Worktree root. When provided, plansDir=<wt>/plans and backlogDir=<wt>/backlog. */
  worktreePath?: string;
  /** Coordinator state dir. When provided, stagingRoot=<stateDir>/plan-staging. */
  stateDir?: string;
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

// The engine runs inside a fresh worktree before any backlog sync to shared
// state has happened, so .orc-state/backlog.json may not reflect the specs
// staged here yet. Scan the filesystem to pick up the authoritative "next
// available number" from the worktree's own backlog/ directory.
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

function resolveDirs(opts: SpecOptions): { plansDir: string; backlogDir: string; stagingRoot: string } {
  // Resolution precedence (most specific wins):
  //   1. Explicit plansDir / backlogDir / stagingRoot in opts.
  //   2. opts.worktreePath — derive plansDir = <worktree>/plans, backlogDir = <worktree>/backlog.
  //   3. opts.stateDir — derive stagingRoot = <stateDir>/plan-staging.
  //   4. Process-level fallback via resolveRepoRoot() for plans/backlog and <repo>/.orc-state for staging.
  const repoRoot = opts.worktreePath ? resolve(opts.worktreePath) : resolveRepoRoot();
  const stateRootForStaging = opts.stateDir
    ? resolve(opts.stateDir)
    : resolve(repoRoot, '.orc-state');
  return {
    plansDir: opts.plansDir ?? resolve(repoRoot, 'plans'),
    backlogDir: opts.backlogDir ?? resolve(repoRoot, 'backlog'),
    stagingRoot: opts.stagingRoot ?? resolve(stateRootForStaging, 'plan-staging'),
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
  // Anchor the closing fence to the start of a line AND end of line/file so a
  // stray `---` inside the plan body (e.g. a markdown horizontal rule) does
  // not terminate frontmatter parsing prematurely. Matches the boundary used
  // by lib/planDocs.ts splitFrontmatter.
  const match = /^(---\s*\n)([\s\S]*?)(\n---(?:\n|$))/.exec(text);
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
  const closingFence = match[3];
  const newContent = `${match[1]}${newFrontmatter}${closingFence}${body}`;
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
    if (createdRefs.length === 0) {
      // No backlog files landed yet — staging is pure temp, safe to remove so
      // the next attempt doesn't trip the mkdir lock.
      rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`publishSpec: publication failed: ${message}`);
    }
    // Partial publication: leave staging in place as a signal that manual
    // rollback is required. The caller must remove the visible backlog files
    // and then `rm -rf` the staging directory before retrying.
    throw new Error(
      `publishSpec: publication failed: ${message}. Visible refs in backlog: ${createdRefs.join(', ')}. derived_task_refs was NOT updated. Roll back the visible refs, then rm -rf ${stagingDir} before retrying.`,
    );
  }

  rmSync(stagingDir, { recursive: true, force: true });

  return {
    plan: { planId: plan.planId, name: plan.name, title: plan.title, path: plan.path },
    createdRefs,
    createdFiles,
    planPath,
  };
}
