import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANS_DIR, STATE_DIR } from './paths.ts';
import { nextPlanId, parsePlan, PlanValidationError } from './planDocs.ts';

export class PlanAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanAuthoringError';
  }
}

export interface WritePlanStep {
  title: string;
  body: string;
  dependsOn?: number[];
}

export interface WritePlanInput {
  name: string;
  title: string;
  objective: string;
  scope: string;
  outOfScope: string;
  constraints: string;
  affectedAreas: string;
  steps: WritePlanStep[];
}

export interface WritePlanOptions {
  stateDir?: string;
  plansDir?: string;
  acknowledgeFeatureCollision?: boolean;
  now?: () => Date;
}

const NAME_SLUG_RE = /^[a-z][a-z0-9-]*$/;

function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function deriveNameTitleFromRequest(request: string): { name: string; title: string } {
  const trimmed = request.trim();
  if (!trimmed) {
    throw new PlanAuthoringError('request is empty — cannot derive name/title');
  }
  const slug = kebab(trimmed).slice(0, 48).replace(/-+$/g, '');
  if (!NAME_SLUG_RE.test(slug)) {
    throw new PlanAuthoringError(
      `derived name must be a lowercase feature slug matching ${NAME_SLUG_RE}, got "${slug}" from request "${request}"`,
    );
  }
  return { name: slug, title: titleCase(trimmed) };
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new PlanAuthoringError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new PlanAuthoringError(`${label} must be a non-empty string`);
  }
  return trimmed;
}

function validateInput(input: WritePlanInput): void {
  if (!NAME_SLUG_RE.test(input.name)) {
    throw new PlanAuthoringError(
      `name must be a lowercase feature slug matching ${NAME_SLUG_RE}, got "${input.name}"`,
    );
  }
  requireNonEmpty('title', input.title);
  requireNonEmpty('objective', input.objective);
  requireNonEmpty('scope', input.scope);
  requireNonEmpty('outOfScope', input.outOfScope);
  requireNonEmpty('constraints', input.constraints);
  requireNonEmpty('affectedAreas', input.affectedAreas);
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new PlanAuthoringError('steps must be a non-empty array');
  }
  for (let i = 0; i < input.steps.length; i += 1) {
    const step = input.steps[i];
    const stepNumber = i + 1;
    requireNonEmpty(`steps[${stepNumber}].title`, step.title);
    requireNonEmpty(`steps[${stepNumber}].body`, step.body);
    if (step.dependsOn !== undefined) {
      if (!Array.isArray(step.dependsOn) || step.dependsOn.some((d) => !Number.isInteger(d) || d < 1)) {
        throw new PlanAuthoringError(`steps[${stepNumber}].dependsOn must be an array of positive integers`);
      }
      for (const dep of step.dependsOn) {
        if (dep >= stepNumber) {
          throw new PlanAuthoringError(
            `steps[${stepNumber}] cannot depend on step ${dep} (must reference an earlier step)`,
          );
        }
      }
    }
  }
}

function readExistingFeatureRefs(stateDir: string): Set<string> {
  const path = join(stateDir, 'backlog.json');
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { features?: Array<{ ref?: string }> };
    const refs = new Set<string>();
    for (const feature of parsed.features ?? []) {
      if (typeof feature.ref === 'string') refs.add(feature.ref);
    }
    return refs;
  } catch {
    return new Set();
  }
}

function renderPlan(params: {
  planId: number;
  name: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  objective: string;
  scope: string;
  outOfScope: string;
  constraints: string;
  affectedAreas: string;
  steps: WritePlanStep[];
}): string {
  const { planId, name, title, createdAt, updatedAt, objective, scope, outOfScope, constraints, affectedAreas, steps } = params;
  const frontmatter = [
    '---',
    `plan_id: ${planId}`,
    `name: ${name}`,
    `title: ${title}`,
    `created_at: ${createdAt}`,
    `updated_at: ${updatedAt}`,
    'derived_task_refs: []',
    '---',
    '',
  ].join('\n');

  const stepBlocks = steps.map((step, index) => {
    const number = index + 1;
    const heading = `### Step ${number} — ${step.title.trim()}`;
    const body = step.body.trim();
    const depsLine = step.dependsOn && step.dependsOn.length > 0
      ? `\n\nDepends on: ${[...step.dependsOn].sort((a, b) => a - b).join(', ')}`
      : '';
    return `${heading}\n\n${body}${depsLine}`;
  }).join('\n\n');

  const body = [
    `# ${title.trim()}`,
    '',
    '## Objective',
    '',
    objective.trim(),
    '',
    '## Scope',
    '',
    scope.trim(),
    '',
    '## Out of Scope',
    '',
    outOfScope.trim(),
    '',
    '## Constraints',
    '',
    constraints.trim(),
    '',
    '## Affected Areas',
    '',
    affectedAreas.trim(),
    '',
    '## Implementation Steps',
    '',
    stepBlocks,
    '',
  ].join('\n');

  return `${frontmatter}${body}`;
}

function atomicWriteTextFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    const fd = openSync(tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    throw err;
  }
}

function validateRenderedContent(content: string, planId: number, name: string): void {
  const probeDir = mkdtempSync(join(tmpdir(), 'plan-authoring-probe-'));
  const probePath = join(probeDir, `${planId}-${name}.md`);
  try {
    writeFileSync(probePath, content, 'utf8');
    parsePlan(probePath);
  } catch (err) {
    if (err instanceof PlanValidationError) {
      throw new PlanAuthoringError(`rendered plan failed validation: ${err.message}`);
    }
    throw err;
  } finally {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export async function writePlan(
  input: WritePlanInput,
  options: WritePlanOptions = {},
): Promise<{ planId: number; path: string }> {
  validateInput(input);

  const stateDir = options.stateDir ?? STATE_DIR;
  const plansDir = options.plansDir ?? PLANS_DIR;

  const existingFeatures = readExistingFeatureRefs(stateDir);
  if (existingFeatures.has(input.name) && options.acknowledgeFeatureCollision !== true) {
    throw new PlanAuthoringError(
      `feature slug "${input.name}" collides with an existing feature in backlog. ` +
      'Pass acknowledgeFeatureCollision: true to accept same-feature re-use, or choose a different slug.',
    );
  }

  const planId = await nextPlanId(plansDir);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const content = renderPlan({
    planId,
    name: input.name,
    title: input.title.trim(),
    createdAt: now,
    updatedAt: now,
    objective: input.objective,
    scope: input.scope,
    outOfScope: input.outOfScope,
    constraints: input.constraints,
    affectedAreas: input.affectedAreas,
    steps: input.steps,
  });

  validateRenderedContent(content, planId, input.name);

  const filename = `${planId}-${input.name}.md`;
  const path = join(plansDir, filename);
  mkdirSync(plansDir, { recursive: true });
  atomicWriteTextFile(path, content);

  return { planId, path };
}
