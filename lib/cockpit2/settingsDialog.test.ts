import { describe, expect, it } from 'vitest';
import { createFrame, cellAt, drawText, type Frame } from './frame.ts';
import {
  buttons, changes, dialogClick, dialogKey, dialogLayout, dimFrame, drawSettingsDialog, modelKey, needsRestart, openSettingsDialog, rows, validate, visibleFields,
  type DialogKey, type SettingsDialogState,
} from './settingsDialog.ts';
import { DEFAULT_THEME, parseThemeColor, styleOf } from './theme.ts';

const SETTINGS = {
  'worker_pool.max_workers': 2,
  'coordinator.merge_strategy': 'direct',
  'worker_pool.provider': 'claude',
  'worker_pool.provider_models.claude': 'opus',
  'worker_pool.provider_models.codex': 'gpt-5-codex',
  'worker_pool.execution_mode': 'full-access',
};
const open = (settings: Record<string, unknown> = SETTINGS) => openSettingsDialog('p1', 'Demo', settings);
const keys = (state: SettingsDialogState, ...pressed: DialogKey[]) => pressed.reduce((current, key) => dialogKey(current, key).state, state);
const valueOf = (state: SettingsDialogState, key: string) => state.fields.find((field) => field.key === key)?.value;
const labels = (state: SettingsDialogState) => visibleFields(state).map((field) => field.label);
const rowText = (frame: Frame, y: number) => frame.cells.slice(y * frame.cols, (y + 1) * frame.cols).map((cell) => cell.text).join('');
const FIVE = ['Max workers', 'Merge', 'Default worker provider', 'Default worker model', 'Execution mode'];

describe('openSettingsDialog', () => {
  it('reads each field from the effective settings, nothing changed, the cursor on the first field', () => {
    const state = open();
    expect(state).toMatchObject({ projectId: 'p1', projectName: 'Demo', cursor: 0, error: null, busy: null });
    expect(state.fields.map(({ key, value, restart }) => ({ key, value, restart }))).toEqual([
      { key: 'worker_pool.max_workers', value: 2, restart: false },
      { key: 'coordinator.merge_strategy', value: 'direct', restart: true },
      { key: 'coordinator.pr_provider', value: null, restart: true },
      { key: 'worker_pool.provider', value: 'claude', restart: false },
      { key: 'worker_pool.provider_models.claude', value: 'opus', restart: false },
      { key: 'worker_pool.execution_mode', value: 'full-access', restart: true },
    ]);
    expect(state.fields.every((field) => field.value === field.original)).toBe(true);
    expect(state.fields[0].options).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(state.fields[4].options).toEqual(['sonnet', 'opus', 'haiku']);
    expect(state.models).toEqual({ claude: 'opus', codex: 'gpt-5-codex', gemini: null });
  });

  it('falls back to orc\'s defaults, and to the project-wide default provider and execution mode', () => {
    const bare = open({});
    expect(bare.fields.map((field) => field.value)).toEqual([0, 'direct', null, 'codex', null, 'full-access']);
    const defaults = open({ default_provider: 'gemini', default_execution_mode: 'sandbox', 'worker_pool.model': 'shared-model' });
    expect(valueOf(defaults, 'worker_pool.provider')).toBe('gemini');
    expect(valueOf(defaults, 'worker_pool.execution_mode')).toBe('sandbox');
    // The model falls back to worker_pool.model, as the coordinator's resolveWorkerModel does.
    expect(defaults.fields[4]).toMatchObject({ key: modelKey('gemini'), value: 'shared-model', options: ['shared-model'] });
    expect(defaults.models).toEqual({ claude: 'shared-model', codex: 'shared-model', gemini: 'shared-model' });
  });

  it('keeps a stored value outside the usual choices selectable', () => {
    const state = open({ ...SETTINGS, 'worker_pool.max_workers': 12, 'worker_pool.provider_models.claude': 'claude-sonnet-4-5' });
    expect(state.fields[0].options).toEqual([12, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(state.fields[4].options).toEqual(['claude-sonnet-4-5', 'sonnet', 'opus', 'haiku']);
  });

  it('modelKey names the per-provider model key, claude when no provider', () => {
    expect(modelKey('codex')).toBe('worker_pool.provider_models.codex');
    expect(modelKey(null)).toBe('worker_pool.provider_models.claude');
  });
});

describe('visibleFields, changes, needsRestart, buttons, rows, validate', () => {
  it('shows the PR provider only while merge is pr', () => {
    const state = open();
    expect(labels(state)).toEqual(FIVE);
    const pr = keys(state, 'down', 'right');
    expect(valueOf(pr, 'coordinator.merge_strategy')).toBe('pr');
    expect(labels(pr)).toEqual(['Max workers', 'Merge', 'PR provider', ...FIVE.slice(2)]);
  });

  it('lists only changed visible fields; a hidden PR provider is not written', () => {
    const state = open();
    expect(changes(state)).toEqual([]);
    const more = keys(state, 'right');
    expect(changes(more)).toEqual([{ key: 'worker_pool.max_workers', value: 3 }]);
    // merge → pr, PR provider → github, then merge back to direct: the provider is hidden and not written.
    const back = keys(state, 'down', 'right', 'down', 'right', 'up', 'right');
    expect(valueOf(back, 'coordinator.pr_provider')).toBe('github');
    expect(changes(back)).toEqual([]);
  });

  it('needs a restart only for a changed restart field; save & restart shows only then', () => {
    const state = open();
    expect(needsRestart(state)).toBe(false);
    expect(buttons(state)).toEqual(['save', 'cancel']);
    expect(needsRestart(keys(state, 'right'))).toBe(false); // max workers applies at once
    const mode = keys(state, 'up', 'up', 'up', 'right'); // up from the first field wraps to the buttons, then the last field
    expect(valueOf(mode, 'worker_pool.execution_mode')).toBe('sandbox');
    expect(needsRestart(mode)).toBe(true);
    expect(buttons(mode)).toEqual(['save', 'saveRestart', 'cancel']);
    expect(rows(mode).map((row) => (row.kind === 'field' ? row.field.label : row.button))).toEqual([...FIVE, 'save', 'saveRestart', 'cancel']);
  });

  it('refuses pr merge without a PR provider', () => {
    const pr = keys(open(), 'down', 'right');
    expect(validate(pr)).toBe('PR merge needs a PR provider.');
    expect(validate(keys(pr, 'down', 'right'))).toBeNull();
    expect(validate(open())).toBeNull();
  });
});

describe('dialogKey', () => {
  it('moves with up/down and next/previous, wrapping over the fields and buttons', () => {
    const state = open();
    expect(keys(state, 'down').cursor).toBe(1);
    expect(keys(state, 'next', 'next').cursor).toBe(2);
    expect(keys(state, 'up').cursor).toBe(6); // the cancel button
    expect(keys(state, 'previous', 'down').cursor).toBe(0);
  });

  it('cycles a field with left/right, both ways and wrapping; an error clears', () => {
    const state = { ...open(), error: 'old' };
    expect(valueOf(keys(state, 'right'), 'worker_pool.max_workers')).toBe(3);
    expect(valueOf(keys(state, 'left', 'left', 'left'), 'worker_pool.max_workers')).toBe(8);
    expect(keys(state, 'right').error).toBeNull();
  });

  it('a single-choice field does not change', () => {
    const state = keys(open(), 'down', 'down', 'right', 'down'); // provider claude → codex, on the model
    expect(valueOf(state, modelKey('codex'))).toBe('gpt-5-codex');
    expect(keys(state, 'right')).toEqual(state);
  });

  it('switching provider swaps in that provider\'s stored model, unchanged, so only the provider is written', () => {
    const codex = keys(open(), 'down', 'down', 'right');
    expect(valueOf(codex, 'worker_pool.provider')).toBe('codex');
    expect(codex.fields[4]).toMatchObject({ key: modelKey('codex'), value: 'gpt-5-codex', original: 'gpt-5-codex', options: ['gpt-5-codex'] });
    expect(changes(codex)).toEqual([{ key: 'worker_pool.provider', value: 'codex' }]);
    const gemini = keys(codex, 'right');
    expect(gemini.fields[4]).toMatchObject({ key: modelKey('gemini'), value: null, options: [null] });
    // Back to claude, then a new model: both written, under claude's key.
    const claude = keys(gemini, 'right', 'down', 'right');
    expect(changes(claude)).toEqual([{ key: modelKey('claude'), value: 'haiku' }]);
  });

  it('left/right move between buttons; enter presses the button under the cursor', () => {
    const onSave = keys(open(), 'up', 'up');
    expect(rows(onSave)[onSave.cursor]).toEqual({ kind: 'button', button: 'save' });
    expect(keys(onSave, 'right').cursor).toBe(6);
    expect(keys(onSave, 'right', 'left').cursor).toBe(5);
    expect(dialogKey(onSave, 'enter').action).toBe('save');
    expect(dialogKey(keys(onSave, 'right'), 'enter').action).toBe('cancel');
  });

  it('enter on a field saves; escape cancels', () => {
    expect(dialogKey(open(), 'enter').action).toBe('save');
    expect(dialogKey(open(), 'escape').action).toBe('cancel');
    expect(dialogKey(open(), 'down').action).toBeNull();
  });

  it('enter with an invalid form shows the error and does nothing; cancel still works', () => {
    const pr = keys(open(), 'down', 'right');
    const step = dialogKey(pr, 'enter');
    expect(step).toEqual({ state: { ...pr, error: 'PR merge needs a PR provider.' }, action: null });
    expect(dialogKey(step.state, 'escape').action).toBe('cancel');
  });

  it('save & restart is pressed by enter on it', () => {
    const state = keys(open(), 'down', 'right', 'down', 'right'); // merge pr, github
    const onRestart = keys(state, 'up', 'up', 'up', 'up'); // from the PR provider up past the first field to the buttons
    expect(rows(onRestart)[onRestart.cursor]).toEqual({ kind: 'button', button: 'saveRestart' });
    expect(dialogKey(onRestart, 'enter').action).toBe('saveRestart');
  });

  it('ignores every key while busy', () => {
    const busy = { ...open(), busy: 'Saving…' };
    for (const key of ['up', 'down', 'left', 'right', 'enter', 'escape', 'next', 'previous'] as DialogKey[]) {
      expect(dialogKey(busy, key)).toEqual({ state: busy, action: null });
    }
  });
});

describe('dialogLayout and dialogClick', () => {
  it('centres a box of at most 52 columns, a row per field, the buttons two rows above its bottom', () => {
    const state = open();
    const layout = dialogLayout(state, 80, 24);
    expect(layout.box).toEqual({ x: 14, y: 5, cols: 52, rows: 13 });
    expect(layout.fieldY).toEqual([7, 8, 9, 10, 11]);
    expect(layout.buttonsY).toBe(16);
    expect(layout.buttonX).toEqual([{ button: 'save', x: 17, cols: 8 }, { button: 'cancel', x: 27, cols: 10 }]);
    expect(dialogLayout(state, 40, 10).box).toEqual({ x: 0, y: 0, cols: 40, rows: 10 });
    const restart = keys(state, 'up', 'up', 'up', 'right');
    expect(dialogLayout(restart, 80, 24).buttonX.map(({ button, x }) => [button, x])).toEqual([['save', 17], ['saveRestart', 27], ['cancel', 47]]);
  });

  it('a click on a label focuses its field; on the value column it cycles it too', () => {
    const state = open();
    const layout = dialogLayout(state, 80, 24);
    const focus = dialogClick(state, layout, 20, 10);
    expect(focus).toEqual({ state: { ...state, cursor: 3 }, action: null });
    const cycled = dialogClick(state, layout, 42, 7);
    expect(cycled.state.cursor).toBe(0);
    expect(valueOf(cycled.state, 'worker_pool.max_workers')).toBe(3);
  });

  it('a click on a button presses it (validated); elsewhere does nothing; nothing while busy', () => {
    const state = open();
    const layout = dialogLayout(state, 80, 24);
    expect(dialogClick(state, layout, 18, 16)).toEqual({ state: { ...state, cursor: 5 }, action: 'save' });
    expect(dialogClick(state, layout, 30, 16).action).toBe('cancel');
    expect(dialogClick(state, layout, 26, 16)).toEqual({ state, action: null }); // between the buttons
    expect(dialogClick(state, layout, 2, 2)).toEqual({ state, action: null });
    const pr = keys(state, 'down', 'right');
    const refused = dialogClick(pr, dialogLayout(pr, 80, 24), 18, dialogLayout(pr, 80, 24).buttonsY);
    expect(refused.action).toBeNull();
    expect(refused.state.error).toBe('PR merge needs a PR provider.');
    const busy = { ...state, busy: 'Saving…' };
    expect(dialogClick(busy, layout, 18, 16)).toEqual({ state: busy, action: null });
  });
});

describe('drawSettingsDialog and dimFrame', () => {
  const panel = parseThemeColor('#202020')!;

  it('draws the titled box, each field with its value, and the buttons, on the panel colour', () => {
    const state = open();
    const frame = createFrame(80, 24);
    const layout = dialogLayout(state, 80, 24);
    drawSettingsDialog(frame, layout, state, DEFAULT_THEME, panel);
    expect(rowText(frame, 5)).toContain('[ SETTINGS · DEMO ]');
    expect(rowText(frame, 7)).toContain('Max workers');
    expect(rowText(frame, 7)).toContain('‹ 2 ›');
    expect(rowText(frame, 8)).toContain('‹ direct ›');
    expect(rowText(frame, 10)).toContain('‹ opus ›');
    expect(rowText(frame, 16)).toContain('[ SAVE ]  [ CANCEL ]');
    // Unchanged: no note.
    expect(rowText(frame, 13).trim()).toMatch(/^│\s*│$/);
    // Inside the box the panel colour, outside it untouched.
    expect(cellAt(frame, 30, 14)!.style.bg).toEqual(panel);
    expect(cellAt(frame, 2, 2)!.style.bg).toEqual({ type: 'default' });
    // The cursor's row in row.cursor.
    expect(cellAt(frame, 16, 7)!.style.bg).toEqual(styleOf(DEFAULT_THEME, 'row.cursor').bg.type === 'default' ? panel : styleOf(DEFAULT_THEME, 'row.cursor').bg);
  });

  it('shows the restart note, a changed value in the accent, the error, and the busy message', () => {
    const frame = () => createFrame(80, 24);
    const mode = keys(open(), 'up', 'up', 'up', 'right');
    const restart = frame();
    drawSettingsDialog(restart, dialogLayout(mode, 80, 24), mode, DEFAULT_THEME, panel);
    expect(rowText(restart, 13)).toContain('! Applies after a coordinator restart.');
    expect(rowText(restart, 16)).toContain('[ SAVE & RESTART ]');
    expect(cellAt(restart, 44, 11)!.style.fg).toEqual(styleOf(DEFAULT_THEME, 'text.accent').fg);
    const live = frame();
    const more = keys(open(), 'right');
    drawSettingsDialog(live, dialogLayout(more, 80, 24), more, DEFAULT_THEME, panel);
    expect(rowText(live, 13)).toContain('Applies at once.');
    const failed = frame();
    const error = { ...more, error: 'boom' };
    drawSettingsDialog(failed, dialogLayout(error, 80, 24), error, DEFAULT_THEME, panel);
    expect(rowText(failed, 13)).toContain('boom');
    const saving = frame();
    const busy = { ...more, busy: 'Saving…' };
    drawSettingsDialog(saving, dialogLayout(busy, 80, 24), busy, DEFAULT_THEME, panel);
    expect(rowText(saving, 13)).toContain('Saving…');
  });

  it('dimFrame dims every cell and keeps its text', () => {
    const frame = createFrame(10, 2);
    drawText(frame, 0, 0, 'hi');
    dimFrame(frame);
    expect(frame.cells.every((cell) => cell.style.dim)).toBe(true);
    expect(rowText(frame, 0)).toBe('hi        ');
  });
});
