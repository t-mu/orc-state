export type ReviewLevel = 'none' | 'light' | 'full';

export interface PlanStepInput {
  number: number;
  title: string;
  body: string;
  dependsOn?: number[];
  groupId?: string | number;
  reviewLevel?: ReviewLevel;
}

export interface PlanInput {
  name: string;
  title: string;
  startTaskNumber: number;
  steps: PlanStepInput[];
}

export interface ProposedTask {
  title: string;
  slug: string;
  ref: string;
  description: string;
  dependsOn: string[];
  reviewLevel: ReviewLevel;
  stepNumbers: number[];
  feature: string;
}

const REVIEW_LEVEL_RANK: Record<ReviewLevel, number> = { none: 0, light: 1, full: 2 };

function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSlug(taskNumber: number, title: string): string {
  const base = kebab(title);
  return base ? `${taskNumber}-${base}` : String(taskNumber);
}

function combineReviewLevels(levels: (ReviewLevel | undefined)[]): ReviewLevel {
  let highest: ReviewLevel | null = null;
  for (const level of levels) {
    if (!level) continue;
    if (highest === null || REVIEW_LEVEL_RANK[level] > REVIEW_LEVEL_RANK[highest]) {
      highest = level;
    }
  }
  return highest ?? 'full';
}

function formatDescription(steps: PlanStepInput[]): string {
  if (steps.length === 1) return steps[0].body.trim();
  // Prefix with "Plan Step" so the number is not confused with the backlog
  // task number when merged-step bodies land in a generated task spec.
  return steps
    .map((step) => `### Plan Step ${step.number} — ${step.title}\n\n${step.body.trim()}`)
    .join('\n\n');
}

interface Group {
  id: string;
  steps: PlanStepInput[];
  firstStepNumber: number;
}

function groupSteps(steps: PlanStepInput[]): Group[] {
  const byId = new Map<string, Group>();
  const ordered: Group[] = [];
  let anonymousCounter = 0;
  for (const step of steps) {
    const rawId = step.groupId;
    const id = rawId !== undefined ? `g:${String(rawId)}` : `s:${anonymousCounter++}`;
    let group = byId.get(id);
    if (!group) {
      group = { id, steps: [], firstStepNumber: step.number };
      byId.set(id, group);
      ordered.push(group);
    } else if (step.number < group.firstStepNumber) {
      group.firstStepNumber = step.number;
    }
    group.steps.push(step);
  }
  for (const group of ordered) {
    group.steps.sort((a, b) => a.number - b.number);
  }
  ordered.sort((a, b) => a.firstStepNumber - b.firstStepNumber);
  return ordered;
}

function validate(input: PlanInput): void {
  if (!input.name) throw new Error('planToBacklog: plan.name is required');
  if (!Number.isInteger(input.startTaskNumber) || input.startTaskNumber < 1) {
    throw new Error('planToBacklog: startTaskNumber must be a positive integer');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error('planToBacklog: plan.steps must be a non-empty array');
  }
  const seen = new Set<number>();
  for (const step of input.steps) {
    if (!Number.isInteger(step.number) || step.number < 1) {
      throw new Error(`planToBacklog: step.number must be a positive integer (got ${step.number})`);
    }
    if (seen.has(step.number)) {
      throw new Error(`planToBacklog: duplicate step number ${step.number}`);
    }
    seen.add(step.number);
    if (!step.title || !step.title.trim()) {
      throw new Error(`planToBacklog: step ${step.number} is missing a title`);
    }
  }
  for (const step of input.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!seen.has(dep)) {
        throw new Error(`planToBacklog: step ${step.number} depends on unknown step ${dep}`);
      }
      if (dep === step.number) {
        throw new Error(`planToBacklog: step ${step.number} cannot depend on itself`);
      }
    }
  }
}

export function planToBacklog(input: PlanInput): ProposedTask[] {
  validate(input);

  const groups = groupSteps(input.steps);

  const stepToGroupIndex = new Map<number, number>();
  groups.forEach((group, index) => {
    for (const step of group.steps) stepToGroupIndex.set(step.number, index);
  });

  return groups.map((group, index) => {
    const headStep = group.steps[0];
    const taskNumber = input.startTaskNumber + index;
    const title = headStep.title.trim();
    const slug = buildSlug(taskNumber, title);
    const ref = `${input.name}/${slug}`;
    const description = formatDescription(group.steps);
    const reviewLevel = combineReviewLevels(group.steps.map((s) => s.reviewLevel));

    const depGroupIndexes = new Set<number>();
    for (const step of group.steps) {
      for (const depStepNumber of step.dependsOn ?? []) {
        const targetIndex = stepToGroupIndex.get(depStepNumber);
        if (targetIndex === undefined) continue;
        if (targetIndex === index) continue;
        depGroupIndexes.add(targetIndex);
      }
    }

    const dependsOn = [...depGroupIndexes]
      .sort((a, b) => a - b)
      .map((depIndex) => {
        const depGroup = groups[depIndex];
        const depTitle = depGroup.steps[0].title.trim();
        const depSlug = buildSlug(input.startTaskNumber + depIndex, depTitle);
        return `${input.name}/${depSlug}`;
      });

    return {
      title,
      slug,
      ref,
      description,
      dependsOn,
      reviewLevel,
      stepNumbers: group.steps.map((s) => s.number),
      feature: input.name,
    };
  });
}
