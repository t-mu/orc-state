import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANS_DIR } from './paths.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { withLockAsync } from './lock.ts';

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export class PlanLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanLookupError';
  }
}

export interface ParsedPlanStep {
  number: number;
  title: string;
  body: string;
  dependsOn: number[];
}

export interface ParsedPlan {
  path: string;
  planId: number;
  name: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  derivedTaskRefs: string[];
  objective: string;
  scope: string;
  outOfScope: string;
  constraints: string;
  affectedAreas: string;
  steps: ParsedPlanStep[];
}

const REQUIRED_SECTIONS: Array<{ heading: string; display: string }> = [
  { heading: 'objective', display: 'Objective' },
  { heading: 'scope', display: 'Scope' },
  { heading: 'out of scope', display: 'Out of Scope' },
  { heading: 'constraints', display: 'Constraints' },
  { heading: 'affected areas', display: 'Affected Areas' },
  { heading: 'implementation steps', display: 'Implementation Steps' },
];

const NAME_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const STEP_HEADING_RE = /^###\s+Step\s+(\d+)(?:\s*[—-]\s*(.+))?\s*$/;
const DEPENDS_ON_LINE_RE = /^Depends\s+on:\s*(.+)$/i;
const DEPENDS_ON_VALUE_RE = /^\d+(\s*,\s*\d+)*$/;
const PLAN_FILE_RE = /^(\d+)-[^/]+\.md$/;

function readPlanFileBytes(path: string): string {
  const buf = readFileSync(path);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new PlanValidationError(`Plan file has UTF-8 BOM prefix (not allowed): ${path}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new PlanValidationError(`Plan file is not valid UTF-8: ${path}`);
  }
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) {
    throw new PlanValidationError('Plan file is missing YAML frontmatter');
  }
  return {
    frontmatter: match[1],
    body: text.slice(match[0].length),
  };
}

function parseScalar(block: string, field: string, required = true): string | null {
  const m = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm').exec(block);
  if (!m) {
    if (required) throw new PlanValidationError(`Missing required frontmatter field: ${field}`);
    return null;
  }
  return m[1].trim();
}

function parseDerivedTaskRefs(block: string): string[] {
  const lines = block.split('\n');
  const idx = lines.findIndex((line) => /^derived_task_refs\s*:/.test(line));
  if (idx === -1) {
    throw new PlanValidationError('Missing required frontmatter field: derived_task_refs');
  }
  const after = lines[idx].replace(/^derived_task_refs\s*:\s*/, '').trim();
  if (after.startsWith('[')) {
    if (!after.endsWith(']')) {
      throw new PlanValidationError('Malformed derived_task_refs: unterminated inline array');
    }
    const inner = after.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (after === '') {
    const refs: string[] = [];
    for (let i = idx + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') break;
      const m = /^\s+-\s+(.+)$/.exec(line);
      if (!m) break;
      refs.push(m[1].trim());
    }
    return refs;
  }
  throw new PlanValidationError(
    'Malformed derived_task_refs: expected [] or inline/multi-line YAML list',
  );
}

function stripFencedCodeBlocks(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    out.push(inFence ? '' : line);
  }
  return out.join('\n');
}

function stripMarkdownLinks(body: string): string {
  return body.replace(/\[([^\]]*)\]\([^)]*\)/g, '');
}

function scanPlaceholders(body: string): void {
  if (/\bTBD\b/.test(body)) {
    throw new PlanValidationError('Plan body contains unresolved placeholder: TBD');
  }
  if (/\bTODO\b/.test(body)) {
    throw new PlanValidationError('Plan body contains unresolved placeholder: TODO');
  }
  if (/\?{3,}/.test(body)) {
    throw new PlanValidationError('Plan body contains unresolved placeholder: ???');
  }
  const bracketScanSource = stripMarkdownLinks(stripFencedCodeBlocks(body));
  const bracketMatch = /\[[^\]]*\]/.exec(bracketScanSource);
  if (bracketMatch) {
    throw new PlanValidationError(
      `Plan body contains unresolved bracketed placeholder: ${bracketMatch[0]}`,
    );
  }
}

function collectH2Sections(body: string): Map<string, { start: number; end: number; body: string }> {
  const lines = body.split('\n');
  const sections = new Map<string, { start: number; end: number; body: string }>();
  let current: { heading: string; start: number } | null = null;

  const flush = (end: number): void => {
    if (!current) return;
    const text = lines.slice(current.start + 1, end).join('\n').trim();
    sections.set(current.heading, { start: current.start, end, body: text });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      flush(i);
      current = { heading: m[1].trim().toLowerCase(), start: i };
    }
  }
  flush(lines.length);
  return sections;
}

function parseDependsOnValue(raw: string): number[] {
  const trimmed = raw.trim();
  if (!DEPENDS_ON_VALUE_RE.test(trimmed)) {
    throw new PlanValidationError(
      `Malformed dependency cue: "Depends on: ${raw}". Expected "Depends on: N" or "Depends on: N, M".`,
    );
  }
  return trimmed.split(',').map((part) => parseInt(part.trim(), 10));
}

function parseStepsSection(body: string): ParsedPlanStep[] {
  const lines = body.split('\n');
  const steps: ParsedPlanStep[] = [];
  let current: { number: number; title: string; bodyLines: string[] } | null = null;

  const finalize = (): void => {
    if (!current) return;
    const stepBody = current.bodyLines.join('\n').trim();
    const dependsOn: number[] = [];
    for (const line of current.bodyLines) {
      const m = DEPENDS_ON_LINE_RE.exec(line.trim());
      if (m) {
        for (const n of parseDependsOnValue(m[1])) {
          if (!dependsOn.includes(n)) dependsOn.push(n);
        }
      }
    }
    steps.push({ number: current.number, title: current.title, body: stepBody, dependsOn });
  };

  for (const line of lines) {
    const h = STEP_HEADING_RE.exec(line);
    if (h) {
      finalize();
      const num = parseInt(h[1], 10);
      const title = (h[2] ?? '').trim();
      current = { number: num, title, bodyLines: [] };
      continue;
    }
    if (/^###\s+/.test(line)) {
      throw new PlanValidationError(
        `Malformed implementation step heading: ${line.trim()}. Expected "### Step N — Title".`,
      );
    }
    if (current) current.bodyLines.push(line);
  }
  finalize();

  if (steps.length === 0) {
    throw new PlanValidationError('Implementation Steps section contains no step headings');
  }

  const seen = new Set<number>();
  for (const step of steps) {
    if (seen.has(step.number)) {
      throw new PlanValidationError(`Duplicate implementation step number: ${step.number}`);
    }
    seen.add(step.number);
  }

  return steps;
}

export function parsePlan(path: string): ParsedPlan {
  const text = readPlanFileBytes(path);
  const { frontmatter, body } = splitFrontmatter(text);

  const planIdRaw = parseScalar(frontmatter, 'plan_id')!;
  const planId = parseInt(planIdRaw, 10);
  if (!/^\d+$/.test(planIdRaw) || Number.isNaN(planId)) {
    throw new PlanValidationError(`plan_id must be a non-negative integer, got "${planIdRaw}"`);
  }

  const name = parseScalar(frontmatter, 'name')!;
  if (!NAME_SLUG_RE.test(name)) {
    throw new PlanValidationError(
      `name must be a lowercase feature slug matching ${NAME_SLUG_RE}, got "${name}"`,
    );
  }

  const title = parseScalar(frontmatter, 'title')!;
  const createdAt = parseScalar(frontmatter, 'created_at')!;
  const updatedAt = parseScalar(frontmatter, 'updated_at')!;
  const derivedTaskRefs = parseDerivedTaskRefs(frontmatter);

  scanPlaceholders(body);

  const sections = collectH2Sections(body);
  for (const { heading, display } of REQUIRED_SECTIONS) {
    if (!sections.has(heading)) {
      throw new PlanValidationError(`Plan is missing required section: ## ${display}`);
    }
  }

  const steps = parseStepsSection(sections.get('implementation steps')!.body);

  return {
    path,
    planId,
    name,
    title,
    createdAt,
    updatedAt,
    derivedTaskRefs,
    objective: sections.get('objective')!.body,
    scope: sections.get('scope')!.body,
    outOfScope: sections.get('out of scope')!.body,
    constraints: sections.get('constraints')!.body,
    affectedAreas: sections.get('affected areas')!.body,
    steps,
  };
}

export function findPlanById(planId: number, dir: string = PLANS_DIR): string {
  if (!Number.isInteger(planId) || planId < 0) {
    throw new PlanLookupError(`plan_id must be a non-negative integer, got ${planId}`);
  }
  if (!existsSync(dir)) {
    throw new PlanLookupError(`No plan found for plan_id ${planId}: plans directory does not exist (${dir})`);
  }
  const prefix = `${planId}-`;
  const matches = readdirSync(dir).filter((name) => {
    if (!name.endsWith('.md')) return false;
    if (!name.startsWith(prefix)) return false;
    const numMatch = PLAN_FILE_RE.exec(name);
    if (!numMatch) return false;
    return parseInt(numMatch[1], 10) === planId;
  });
  if (matches.length === 0) {
    throw new PlanLookupError(`No plan found for plan_id ${planId} in ${dir}`);
  }
  if (matches.length > 1) {
    throw new PlanLookupError(
      `Duplicate plans for plan_id ${planId}: ${matches.join(', ')}`,
    );
  }
  return join(dir, matches[0]);
}

function scanMaxPlanId(dir: string): number {
  if (!existsSync(dir)) return 0;
  let max = 0;
  for (const entry of readdirSync(dir)) {
    const m = PLAN_FILE_RE.exec(entry);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

interface PlanIdCounter {
  last: number;
}

function readCounter(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PlanIdCounter;
    return typeof parsed.last === 'number' && Number.isInteger(parsed.last) && parsed.last >= 0
      ? parsed.last
      : 0;
  } catch {
    return 0;
  }
}

let inProcessAllocChain: Promise<unknown> = Promise.resolve();

export async function nextPlanId(dir: string = PLANS_DIR): Promise<number> {
  const chained = inProcessAllocChain.then(() => allocateNextPlanId(dir));
  inProcessAllocChain = chained.catch(() => undefined);
  return chained;
}

async function allocateNextPlanId(dir: string): Promise<number> {
  mkdirSync(dir, { recursive: true });
  const lockFile = join(dir, '.lock');
  const counterFile = join(dir, '.next-id.json');
  return withLockAsync(lockFile, () => {
    const fileMax = scanMaxPlanId(dir);
    const counterMax = readCounter(counterFile);
    const next = Math.max(fileMax, counterMax) + 1;
    atomicWriteJson(counterFile, { last: next });
    return Promise.resolve(next);
  });
}
