import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { parsePlan } from './planDocs.ts';
import { deriveNameTitleFromRequest, PlanAuthoringError, writePlan } from './planAuthoring.ts';

let rootDir: string;
let stateDir: string;
let plansDir: string;

beforeEach(() => {
  rootDir = createTempStateDir('plan-authoring-');
  stateDir = join(rootDir, '.orc-state');
  plansDir = join(rootDir, 'plans');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
});

afterEach(() => {
  cleanupTempStateDir(rootDir);
});

function validInput(overrides: Partial<Parameters<typeof writePlan>[0]> = {}) {
  return {
    name: 'gemini-cli-integration',
    title: 'Add Gemini CLI Integration',
    objective: 'Ship a new Gemini adapter so workers can use Gemini as a provider.',
    scope: '- Adapter binding for Gemini CLI.\n- Provider config wiring.',
    outOfScope: '- Managed-API Gemini support.',
    constraints: '- Must not change the existing Codex adapter.',
    affectedAreas: '- adapters/gemini.ts\n- lib/providers.ts',
    steps: [
      { title: 'Add adapter', body: 'Wire the Gemini CLI adapter under adapters/gemini.ts.' },
      { title: 'Wire provider', body: 'Register gemini in the provider resolver.', dependsOn: [1] },
    ],
    ...overrides,
  };
}

describe('deriveNameTitleFromRequest', () => {
  it('derives a kebab-case name and title from the user request', () => {
    const { name, title } = deriveNameTitleFromRequest('add gemini cli integration');
    expect(name).toBe('add-gemini-cli-integration');
    expect(title).toBe('Add Gemini Cli Integration');
  });

  it('trims punctuation, collapses whitespace, and truncates long requests', () => {
    const request = 'Refactor!! the   streaming/event   pipeline — separate concerns more clearly';
    const { name, title } = deriveNameTitleFromRequest(request);
    expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name.endsWith('-')).toBe(false);
    expect(title.length).toBeGreaterThan(0);
  });

  it('throws on empty request', () => {
    expect(() => deriveNameTitleFromRequest('   ')).toThrow(PlanAuthoringError);
  });

  it('throws when the derived slug does not start with a letter', () => {
    expect(() => deriveNameTitleFromRequest('42 things to do')).toThrow(PlanAuthoringError);
  });
});

describe('writePlan', () => {
  it('allocates plan_id via nextPlanId and writes plans/<plan_id>-<slug>.md', async () => {
    const { planId, path } = await writePlan(validInput(), { stateDir, plansDir });
    expect(planId).toBe(1);
    expect(path).toBe(join(plansDir, '1-gemini-cli-integration.md'));
    expect(existsSync(path)).toBe(true);

    const next = await writePlan(validInput({ name: 'another-plan', title: 'Another' }), {
      stateDir,
      plansDir,
    });
    expect(next.planId).toBe(2);
    expect(next.path).toBe(join(plansDir, '2-another-plan.md'));
  });

  it('writes derived_task_refs: [] on fresh plans', async () => {
    const { path } = await writePlan(validInput(), { stateDir, plansDir });
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/^derived_task_refs:\s*\[\]\s*$/m);
    expect(parsePlan(path).derivedTaskRefs).toEqual([]);
  });

  it('round-trips through parsePlan without validation errors', async () => {
    const { path } = await writePlan(validInput(), { stateDir, plansDir });
    const parsed = parsePlan(path);
    expect(parsed.planId).toBe(1);
    expect(parsed.name).toBe('gemini-cli-integration');
    expect(parsed.title).toBe('Add Gemini CLI Integration');
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]).toMatchObject({ number: 1, title: 'Add adapter', dependsOn: [] });
    expect(parsed.steps[1]).toMatchObject({ number: 2, title: 'Wire provider', dependsOn: [1] });
  });

  it('rejects plan input with empty required sections', async () => {
    await expect(
      writePlan(validInput({ objective: '' }), { stateDir, plansDir }),
    ).rejects.toThrow(PlanAuthoringError);
    await expect(
      writePlan(validInput({ scope: '   ' }), { stateDir, plansDir }),
    ).rejects.toThrow(/scope/);
  });

  it('rejects plan input whose rendered body contains placeholders', async () => {
    await expect(
      writePlan(validInput({ objective: 'TBD later' }), { stateDir, plansDir }),
    ).rejects.toThrow(/TBD|validation/);
    await expect(
      writePlan(validInput({ constraints: 'see [fill this in]' }), { stateDir, plansDir }),
    ).rejects.toThrow(/bracketed|validation/);
  });

  it('rejects steps array that is empty or missing bodies', async () => {
    await expect(
      writePlan(validInput({ steps: [] }), { stateDir, plansDir }),
    ).rejects.toThrow(/steps/);
    await expect(
      writePlan(
        validInput({ steps: [{ title: 'Only title', body: '' }] }),
        { stateDir, plansDir },
      ),
    ).rejects.toThrow(/body/);
  });

  it('rejects an invalid name slug', async () => {
    await expect(
      writePlan(validInput({ name: 'Not A Slug' }), { stateDir, plansDir }),
    ).rejects.toThrow(/name/);
  });

  it('does not touch .orc-state/backlog.json or invoke git', async () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const initialBacklog = JSON.stringify(
      { version: '1', features: [{ ref: 'unrelated', title: 'Unrelated', tasks: [] }] },
      null,
      2,
    );
    writeFileSync(backlogPath, initialBacklog);

    // Initialize a real git repo so we can detect any commits or working-tree mutations.
    execSync('git init --quiet', { cwd: rootDir });
    execSync('git config user.email test@example.com', { cwd: rootDir });
    execSync('git config user.name tester', { cwd: rootDir });
    writeFileSync(join(rootDir, '.gitkeep'), '');
    execSync('git add .', { cwd: rootDir });
    execSync('git commit --quiet -m init', { cwd: rootDir });
    const headBefore = execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();

    const { path } = await writePlan(validInput(), { stateDir, plansDir });
    expect(existsSync(path)).toBe(true);

    // backlog.json is untouched.
    expect(readFileSync(backlogPath, 'utf8')).toBe(initialBacklog);

    // HEAD is unchanged.
    const headAfter = execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);

    // The plan file shows up as an untracked change, but nothing under .orc-state is modified.
    const status = execSync('git status --porcelain', { cwd: rootDir, encoding: 'utf8' });
    expect(status).not.toMatch(/\.orc-state\//);
  });

  it('rejects unrelated feature-slug collisions by default', async () => {
    const backlogPath = join(stateDir, 'backlog.json');
    writeFileSync(
      backlogPath,
      JSON.stringify(
        {
          version: '1',
          features: [{ ref: 'gemini-cli-integration', title: 'Gemini', tasks: [] }],
        },
        null,
        2,
      ),
    );

    await expect(
      writePlan(validInput(), { stateDir, plansDir }),
    ).rejects.toThrow(/collides/);
  });

  it('accepts a same-feature collision when acknowledgeFeatureCollision is true', async () => {
    const backlogPath = join(stateDir, 'backlog.json');
    writeFileSync(
      backlogPath,
      JSON.stringify(
        {
          version: '1',
          features: [{ ref: 'gemini-cli-integration', title: 'Gemini', tasks: [] }],
        },
        null,
        2,
      ),
    );

    const { planId, path } = await writePlan(validInput(), {
      stateDir,
      plansDir,
      acknowledgeFeatureCollision: true,
    });
    expect(planId).toBe(1);
    expect(existsSync(path)).toBe(true);
  });

  it('does not leave probe artifacts behind', async () => {
    await writePlan(validInput(), { stateDir, plansDir });
    const entries = readdirSync(plansDir);
    expect(entries.some((name) => name.startsWith('.plan-authoring-probe'))).toBe(false);
  });

  it('rejects titles containing line breaks', async () => {
    await expect(
      writePlan(validInput({ title: 'First line\nSecond line' }), { stateDir, plansDir }),
    ).rejects.toThrow(/line breaks/);
  });

  it('does not advance the plan_id counter on validation failure', async () => {
    // First: a valid write consumes plan_id 1.
    const first = await writePlan(validInput(), { stateDir, plansDir });
    expect(first.planId).toBe(1);

    // Second: a validation-failing write must NOT consume plan_id 2.
    await expect(
      writePlan(validInput({ name: 'another', objective: 'TBD' }), { stateDir, plansDir }),
    ).rejects.toThrow();

    // Third: the next valid write should get plan_id 2, not 3.
    const third = await writePlan(validInput({ name: 'third-plan' }), { stateDir, plansDir });
    expect(third.planId).toBe(2);
  });
});
