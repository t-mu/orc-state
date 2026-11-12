/**
 * lib/cockpit2/confirmDialog.ts — a confirmation dialog: a title, a message
 * and two buttons, the confirming one (`[ KILL ]`, in `button.danger`) and
 * `[ CANCEL ]`, drawn on the dialog layer as the settings dialog is
 * (settingsDialog.ts: over the dimmed frame, centred, at most 52 columns).
 *
 * Pure: the state, what a key or click does to it, and how it is drawn. The
 * app (app.ts) opens it, routes every key and click to it while it is open,
 * runs what was confirmed and shows a failure in it (`error`) or closes it.
 */
import { stringWidth } from '../cellWidth.ts';
import { fitText } from '../tui/sidebar.ts';
import { wrapText } from '../tui/taskList.ts';
import { drawBox } from './chrome.ts';
import { drawText, fillRect, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { styleOf, type Theme } from './theme.ts';

export type ConfirmButton = 'confirm' | 'cancel';

export interface ConfirmDialogState {
  /** The box's title (drawBox shows it upper-case). */
  title: string;
  /** The message, one paragraph per entry, wrapped to the dialog's width. */
  message: string[];
  /** The confirming button's word (`KILL`). */
  confirmLabel: string;
  /** The button under the cursor; it starts on the confirming one (the dialog is the confirmation). */
  cursor: ConfirmButton;
  /** Why the confirmed action failed (its first line), shown above the buttons. */
  error: string | null;
  /** While the confirmed action runs: keys and clicks are ignored. */
  busy: string | null;
}

export function openConfirmDialog(options: { title: string; message: string[]; confirmLabel: string }): ConfirmDialogState {
  return { ...options, cursor: 'confirm', error: null, busy: null };
}

export type ConfirmKey = 'left' | 'right' | 'next' | 'previous' | 'enter' | 'escape';
export type ConfirmAction = 'confirm' | 'cancel' | null;
export interface ConfirmStep { state: ConfirmDialogState; action: ConfirmAction }

const BUTTONS: readonly ConfirmButton[] = ['confirm', 'cancel'];
const other = (button: ConfirmButton): ConfirmButton => (button === 'confirm' ? 'cancel' : 'confirm');

/** What a key does: move between the buttons, press the one under the cursor, or cancel. */
export function confirmDialogKey(state: ConfirmDialogState, key: ConfirmKey): ConfirmStep {
  if (state.busy) return { state, action: null };
  switch (key) {
    case 'escape': return { state, action: 'cancel' };
    case 'enter': return { state, action: state.cursor };
    default: return { state: { ...state, cursor: other(state.cursor) }, action: null };
  }
}

// ── layout and drawing ─────────────────────────────────────────────────────────

const DIALOG_COLS = 52;
/** Columns between the box's border and its text, each side. */
const PAD = 2;
const BUTTON_GAP = 2;

export const buttonLabel = (state: ConfirmDialogState, button: ConfirmButton): string => (button === 'confirm' ? `[ ${state.confirmLabel} ]` : '[ CANCEL ]');

/** Where the dialog sits in a `cols` by `rows` frame, its wrapped message lines and its buttons. */
export interface ConfirmLayout {
  box: Region;
  lines: string[];
  /** The y of the first message line. */
  messageY: number;
  /** The error's or busy note's row. */
  noteY: number;
  buttonsY: number;
  buttonX: Array<{ button: ConfirmButton; x: number; cols: number }>;
}

/**
 * The box: a border row, a blank row, the message, a blank row, the note row,
 * the buttons and the border row; centred, at most 52 columns, cut to the
 * frame (the message loses its last lines first).
 */
export function confirmDialogLayout(state: ConfirmDialogState, cols: number, rows: number): ConfirmLayout {
  const width = Math.min(cols, DIALOG_COLS);
  const textCols = Math.max(1, width - 2 * PAD);
  const wrapped = state.message.flatMap((paragraph) => wrapText(paragraph, textCols).map((line) => fitText(line, textCols)));
  const chrome = 6;
  const lines = wrapped.slice(0, Math.max(0, rows - chrome));
  const height = Math.min(rows, lines.length + chrome);
  const box = { x: Math.max(0, Math.floor((cols - width) / 2)), y: Math.max(0, Math.floor((rows - height) / 2)), cols: width, rows: height };
  const buttonsY = box.y + box.rows - 2;
  let x = box.x + PAD + 1;
  const buttonX = BUTTONS.map((button) => {
    const at = { button, x, cols: stringWidth(buttonLabel(state, button)) };
    x += at.cols + BUTTON_GAP;
    return at;
  });
  return { box, lines, messageY: box.y + 2, noteY: buttonsY - 1, buttonsY, buttonX };
}

/** What a click at (x, y) does: a button presses it (the cursor goes to it); anything else nothing. */
export function confirmDialogClick(state: ConfirmDialogState, layout: ConfirmLayout, x: number, y: number): ConfirmStep {
  if (state.busy || y !== layout.buttonsY) return { state, action: null };
  const hit = layout.buttonX.find((button) => x >= button.x && x < button.x + button.cols);
  return hit ? { state: { ...state, cursor: hit.button }, action: hit.button } : { state, action: null };
}

/**
 * Draws the dialog over `frame` (the app dims what is behind it first): a box
 * in the panel colour with the message, the error (`error`) or busy note
 * (`text.muted`), and the buttons, both filled (the confirming one in
 * `button.danger`, cancel in `tab.inactive`), a `▸` before the one under the cursor.
 */
export function drawConfirmDialog(frame: Frame, layout: ConfirmLayout, state: ConfirmDialogState, theme: Theme, panel: CellStyle['bg']): void {
  const { box } = layout;
  fillRect(frame, box, { ...styleOf(theme, 'text.primary'), bg: panel });
  drawBox(frame, box, { title: state.title, focused: true, theme });
  const inner = box.cols - 2 * PAD;
  const onPanel = (style: CellStyle): CellStyle => (style.bg.type === 'default' ? { ...style, bg: panel } : style);
  layout.lines.forEach((line, index) => {
    drawText(frame, box.x + PAD, layout.messageY + index, line, onPanel(styleOf(theme, 'text.primary')), inner);
  });
  const note = state.busy ?? state.error;
  if (note && layout.noteY > layout.messageY + layout.lines.length - 1) {
    drawText(frame, box.x + PAD, layout.noteY, fitText(note, inner), onPanel(styleOf(theme, state.error && !state.busy ? 'error' : 'text.muted')), inner);
  }
  const right = box.x + box.cols - 1;
  for (const { button, x } of layout.buttonX) {
    if (state.cursor === button) drawText(frame, x - 1, layout.buttonsY, '▸', onPanel(styleOf(theme, 'text.accent')), 1);
    drawText(frame, x, layout.buttonsY, buttonLabel(state, button), onPanel(styleOf(theme, button === 'confirm' ? 'button.danger' : 'tab.inactive')), right - x);
  }
}
