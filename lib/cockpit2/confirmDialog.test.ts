import { describe, expect, it } from 'vitest';
import {
  confirmDialogClick, confirmDialogKey, confirmDialogLayout, drawConfirmDialog, openConfirmDialog, type ConfirmDialogState,
} from './confirmDialog.ts';
import { createFrame } from './frame.ts';
import { BUILT_IN_THEMES, styleOf } from './theme.ts';

const AMBER = BUILT_IN_THEMES.amber;
const MESSAGE = 'Kill w1? Its run is cancelled and feat/one goes back to the backlog (task reset); a new worker picks it up.';
const open = (): ConfirmDialogState => openConfirmDialog({ title: 'kill · w1', message: [MESSAGE], confirmLabel: 'KILL' });

describe('confirmDialogKey', () => {
  it('starts on the confirming button; Enter presses the button under the cursor', () => {
    const state = open();
    expect(state).toMatchObject({ cursor: 'confirm', error: null, busy: null });
    expect(confirmDialogKey(state, 'enter')).toEqual({ state, action: 'confirm' });
    const moved = confirmDialogKey(state, 'right').state;
    expect(moved.cursor).toBe('cancel');
    expect(confirmDialogKey(moved, 'enter').action).toBe('cancel');
    for (const key of ['left', 'next', 'previous'] as const) expect(confirmDialogKey(moved, key).state.cursor).toBe('confirm');
  });

  it('cancels on escape, and ignores every key while busy', () => {
    expect(confirmDialogKey(open(), 'escape').action).toBe('cancel');
    const busy = { ...open(), busy: 'Killing…' };
    for (const key of ['enter', 'escape', 'right'] as const) expect(confirmDialogKey(busy, key)).toEqual({ state: busy, action: null });
  });
});

describe('confirmDialogLayout and confirmDialogClick', () => {
  it('centres a box at most 52 columns wide with the message wrapped inside it and the buttons above its bottom border', () => {
    const layout = confirmDialogLayout(open(), 80, 24);
    expect(layout.box.cols).toBe(52);
    expect(layout.box.x).toBe(14);
    expect(layout.lines.length).toBe(3);
    for (const line of layout.lines) expect(line.length).toBeLessThanOrEqual(48);
    expect(layout.box.rows).toBe(layout.lines.length + 6);
    expect(layout.buttonsY).toBe(layout.box.y + layout.box.rows - 2);
    expect(layout.buttonX.map(({ button, cols }) => [button, cols])).toEqual([['confirm', 8], ['cancel', 10]]);
    expect(layout.buttonX[1].x).toBe(layout.buttonX[0].x + 8 + 2);
  });

  it('presses a clicked button, the cursor following; a click elsewhere or while busy does nothing', () => {
    const state = open();
    const layout = confirmDialogLayout(state, 80, 24);
    const [kill, cancel] = layout.buttonX;
    expect(confirmDialogClick(state, layout, kill.x + 3, layout.buttonsY).action).toBe('confirm');
    expect(confirmDialogClick(state, layout, cancel.x, layout.buttonsY)).toEqual({ state: { ...state, cursor: 'cancel' }, action: 'cancel' });
    expect(confirmDialogClick(state, layout, kill.x + 8, layout.buttonsY).action).toBeNull();
    expect(confirmDialogClick(state, layout, kill.x, layout.messageY).action).toBeNull();
    const busy = { ...state, busy: 'Killing…' };
    expect(confirmDialogClick(busy, layout, kill.x, layout.buttonsY)).toEqual({ state: busy, action: null });
  });

  it('fits a short frame: the message loses lines, the buttons stay', () => {
    const layout = confirmDialogLayout(open(), 80, 7);
    expect(layout.box.rows).toBe(7);
    expect(layout.lines.length).toBe(1);
    expect(layout.buttonsY).toBe(5);
  });
});

describe('drawConfirmDialog', () => {
  const draw = (state: ConfirmDialogState) => {
    const frame = createFrame(80, 24);
    const layout = confirmDialogLayout(state, 80, 24);
    drawConfirmDialog(frame, layout, state, AMBER, { type: 'default' });
    const row = (y: number) => frame.cells.slice(y * 80, y * 80 + 80).map((cell) => cell.text).join('');
    return { frame, layout, row };
  };

  it('draws the title, the message, KILL in button.danger and CANCEL in tab.inactive, a marker before the cursor\'s button', () => {
    const { frame, layout, row } = draw(open());
    expect(row(layout.box.y)).toContain('KILL · W1');
    expect(row(layout.messageY)).toContain('Kill w1? Its run is cancelled');
    const [kill, cancel] = layout.buttonX;
    expect(row(layout.buttonsY).slice(kill.x - 1, cancel.x + cancel.cols)).toBe('▸[ KILL ]  [ CANCEL ]');
    expect(frame.cells[layout.buttonsY * 80 + kill.x].style).toEqual(styleOf(AMBER, 'button.danger'));
    expect(frame.cells[layout.buttonsY * 80 + cancel.x].style).toEqual(styleOf(AMBER, 'tab.inactive'));
    const moved = draw({ ...open(), cursor: 'cancel' });
    expect(moved.row(moved.layout.buttonsY).slice(kill.x - 1, cancel.x + cancel.cols)).toBe(' [ KILL ] ▸[ CANCEL ]');
  });

  it('shows the error in the error role, and the busy note instead while busy', () => {
    const failed = draw({ ...open(), error: 'task not found' });
    expect(failed.row(failed.layout.noteY)).toContain('task not found');
    expect(failed.frame.cells[failed.layout.noteY * 80 + failed.layout.box.x + 2].style.fg).toEqual(styleOf(AMBER, 'error').fg);
    const busy = draw({ ...open(), error: 'task not found', busy: 'Killing…' });
    expect(busy.row(busy.layout.noteY)).toContain('Killing…');
    expect(busy.row(busy.layout.noteY)).not.toContain('task not found');
  });
});
