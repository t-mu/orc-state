import { describe, expect, it } from 'vitest';
import { createFrame } from './frame.ts';
import { addProjectRequest, openAddProjectDialog } from './addProjectDialog.ts';
import { drawForm, focusedField, formClick, formKey, formLayout, formType, formValue, typingInForm, type FormState } from './formDialog.ts';
import { CUSTOM_AGENT, FRESH_SESSION, NO_CUSTOM_AGENTS, agentCommand, agentLaunchOptions, newAgentRequest, newAgentStep, openNewAgentDialog } from './newAgentDialog.ts';
import { DEFAULT_THEME } from './theme.ts';

const rowText = (frame: ReturnType<typeof createFrame>, y: number) => frame.cells.slice(y * frame.cols, (y + 1) * frame.cols).map((cell) => cell.text).join('');
const type = (state: FormState, text: string) => formType(state, text).state;

describe('formDialog (the add-project form)', () => {
  it('types into the focused text field, letters that are keys elsewhere included', () => {
    let state = openAddProjectDialog();
    expect(typingInForm(state)).toBe(true);
    state = type(state, '/home/jq');
    expect(formValue(state, 'path')).toBe('/home/jq');
    state = formKey(state, 'backspace').state;
    state = formKey(state, 'left').state;
    state = type(state, 'x');
    expect(formValue(state, 'path')).toBe('/home/xj');
    state = formKey(state, 'clear').state;
    expect(formValue(state, 'path')).toBe('');
  });

  it('moves over the fields and buttons, cycles a choice, and types nothing into a choice', () => {
    let state = formKey(openAddProjectDialog(), 'down').state;
    expect(focusedField(state)?.key).toBe('name');
    state = formKey(state, 'next').state;
    expect(focusedField(state)?.key).toBe('provider');
    expect(typingInForm(state)).toBe(false);
    expect(formType(state, 'x').state).toBe(state);
    state = formKey(state, 'right').state;
    expect(formValue(state, 'provider')).toBe('codex');
    state = formKey(state, 'space').state;
    expect(formValue(state, 'provider')).toBe('gemini');
    state = formKey(state, 'left').state;
    expect(formValue(state, 'provider')).toBe('codex');
    state = formKey(state, 'down').state;
    expect(focusedField(state)).toBeNull();
    // Between buttons ←/→ move.
    expect(formKey(state, 'right').state.cursor).toBe(4);
    expect(formKey(formKey(state, 'down').state, 'enter').action).toBe('cancel');
    // Up from the first row wraps to the last button.
    expect(formKey(openAddProjectDialog(), 'up').state.cursor).toBe(4);
  });

  it('presses the first button on Enter in a field, cancels on Esc, and ignores everything while busy', () => {
    expect(formKey(openAddProjectDialog(), 'enter').action).toBe('add');
    expect(formKey(openAddProjectDialog(), 'escape').action).toBe('cancel');
    const busy = { ...openAddProjectDialog(), busy: 'Adding…' };
    expect(formKey(busy, 'escape')).toEqual({ state: busy, action: null });
    expect(formType(busy, 'x').state).toBe(busy);
    expect(typingInForm(busy)).toBe(false);
  });

  it('validates ADD: the path is required and absolute; a blank name is null', () => {
    expect(addProjectRequest(openAddProjectDialog())).toEqual({ error: 'Path is required: the git checkout to add.' });
    expect(addProjectRequest(type(openAddProjectDialog(), 'repo'))).toEqual({ error: 'Path must be absolute (start with /).' });
    let state = type(openAddProjectDialog(), ' /work/app ');
    expect(addProjectRequest(state)).toEqual({ path: '/work/app', name: null, provider: 'claude' });
    state = type(formKey(state, 'down').state, 'My App');
    expect(addProjectRequest(state)).toEqual({ path: '/work/app', name: 'My App', provider: 'claude' });
  });

  it('lays out and draws the form; a click focuses a field, cycles a choice\'s value, presses a button', () => {
    const state = type(openAddProjectDialog(), '/work/app');
    const layout = formLayout(state, 80, 24);
    expect(layout.box).toEqual({ x: 14, y: 7, cols: 52, rows: 9 });
    expect(layout.fieldY).toEqual([9, 10, 11]);
    const frame = createFrame(80, 24);
    drawForm(frame, layout, { ...state, error: 'Path is not a git checkout' }, DEFAULT_THEME, { type: 'default' });
    expect(rowText(frame, 7)).toContain('[ NEW CAMPAIGN ]');
    expect(rowText(frame, 9)).toContain('Path        /work/app');
    expect(rowText(frame, 10)).toContain('optional: the folder name');
    expect(rowText(frame, 11)).toContain('‹ claude ›');
    expect(rowText(frame, layout.noteY)).toContain('Path is not a git checkout');
    expect(rowText(frame, layout.buttonsY)).toContain('[ ADD ]  [ CANCEL ]');
    expect(focusedField(formClick(state, layout, 20, 10).state)?.key).toBe('name');
    expect(formValue(formClick(state, layout, layout.valueX + 1, 11).state, 'provider')).toBe('codex');
    const add = layout.buttonX[0];
    expect(formClick(state, layout, add.x + 1, layout.buttonsY).action).toBe('add');
    expect(formClick(state, layout, 0, 0).action).toBeNull();
  });
});

describe('newAgentDialog', () => {
  const critic = { name: 'critic', description: 'Reviews', prompt: 'You are the critic.' };
  const step = (state: ReturnType<typeof openNewAgentDialog>, key: Parameters<typeof formKey>[1]) => newAgentStep(state, formKey(state.form, key)).state;

  it('starts on the project\'s provider (claude when unknown) and a fresh session, the Agent row hidden', () => {
    const state = openNewAgentDialog('demo', 'codex', [critic]);
    expect(formValue(state.form, 'provider')).toBe('codex');
    expect(formValue(state.form, 'variant')).toBe(FRESH_SESSION);
    expect(formLayout(state.form, 80, 24).fieldY).toHaveLength(2);
    expect(formValue(openNewAgentDialog('demo', null, []).form, 'provider')).toBe('claude');
    expect(formValue(openNewAgentDialog('demo', 'other', []).form, 'provider')).toBe('claude');
    expect(newAgentRequest(state)).toEqual({ provider: 'codex', agent: null });
  });

  it('shows the Agent row for a custom agent and starts the chosen definition', () => {
    let state = step(openNewAgentDialog('demo', 'claude', [critic, { ...critic, name: 'integrator' }]), 'down');
    state = step(state, 'right');
    expect(formValue(state.form, 'variant')).toBe(CUSTOM_AGENT);
    expect(formLayout(state.form, 80, 24).fieldY).toHaveLength(3);
    expect(newAgentRequest(state)).toEqual({ provider: 'claude', agent: critic });
    state = step(step(state, 'down'), 'right');
    expect(newAgentRequest(state)).toMatchObject({ agent: { name: 'integrator' } });
  });

  it('refuses a custom agent when the checkout has none, saying so in the Agent row', () => {
    const state = step(step(openNewAgentDialog('demo', 'claude', []), 'down'), 'right');
    expect(newAgentRequest(state)).toEqual({ error: 'No custom agents in .claude/agents to start.' });
    const frame = createFrame(80, 24);
    drawForm(frame, formLayout(state.form, 80, 24), state.form, DEFAULT_THEME, { type: 'default' });
    expect(Array.from({ length: 24 }, (_, y) => rowText(frame, y)).join('\n')).toContain(NO_CUSTOM_AGENTS);
  });

  it('runs the provider\'s own CLI, skipping its permission prompts under full-access (the default), with the project model', () => {
    expect(agentCommand('claude')).toBe('claude --dangerously-skip-permissions');
    expect(agentCommand('codex')).toBe('codex --dangerously-bypass-approvals-and-sandbox');
    expect(agentCommand('gemini')).toBe('gemini --yolo');
    expect(agentCommand('codex', { executionMode: 'full-access', model: 'gpt-6.1-sol' })).toBe('codex --dangerously-bypass-approvals-and-sandbox --model gpt-6.1-sol');
    expect(agentCommand('claude', { executionMode: 'sandbox' })).toBe('claude');
    expect(agentCommand('gemini', { executionMode: 'sandbox', model: 'flash' })).toBe('gemini --model flash');
    // A model that is not a plain id never reaches the shell command.
    expect(agentCommand('claude', { model: 'sonnet; rm -rf /' })).toBe('claude --dangerously-skip-permissions');
  });

  it('takes the execution mode and the provider\'s default model from the project settings', () => {
    expect(agentLaunchOptions({}, 'codex')).toEqual({ executionMode: null, model: null });
    expect(agentLaunchOptions({ default_execution_mode: 'sandbox', 'worker_pool.model': 'shared' }, 'codex')).toEqual({ executionMode: 'sandbox', model: 'shared' });
    expect(agentLaunchOptions({
      default_execution_mode: 'sandbox', 'worker_pool.execution_mode': 'full-access',
      'worker_pool.model': 'shared', 'worker_pool.provider_models.codex': 'gpt-6.1-sol',
    }, 'codex')).toEqual({ executionMode: 'full-access', model: 'gpt-6.1-sol' });
  });
});
