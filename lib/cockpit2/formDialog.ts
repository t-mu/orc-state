/**
 * lib/cockpit2/formDialog.ts — a small form on the dialog layer: labelled
 * text fields (textField.ts) and choices, a note row (an error or what is
 * under way) and a row of buttons. The add-project and new-agent dialogs
 * (addProjectDialog.ts, newAgentDialog.ts) are forms; the app (app.ts)
 * routes every key, typed character, paste and click to the open one.
 *
 * Pure: the state, what a key, typed text or click does to it, and how it
 * is drawn (as the settings dialog is: over the dimmed frame, centred, at
 * most 52 columns, in the panel colour).
 *
 * Keys: ↑/↓, Tab/Shift-Tab move over the shown fields and the buttons; on a
 * text field ←/→, Home, End, Backspace, Delete and Ctrl-U edit it and every
 * printable character (`h`, `j`, `q` and Space included) and a paste is
 * typed into it; on a choice ←/→, `h`/`l` or Space change it; between
 * buttons they move; elsewhere `j`/`k` move and `q` cancels. Enter on a
 * field presses the first button, on a button presses it; Esc cancels.
 */
import { stringWidth } from '../cellWidth.ts';
import { drawBox } from './chrome.ts';
import { drawText, fillRect, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { textFieldInsert, textFieldKey, drawTextField, type TextFieldKey, type TextFieldState } from './textField.ts';
import { styleOf, type Theme, type ThemeRole } from './theme.ts';

export type FormField =
  | { kind: 'text'; key: string; label: string; text: TextFieldState; placeholder?: string; hidden?: boolean }
  | {
    kind: 'choice'; key: string; label: string; options: string[]; value: string;
    /** Shown instead of a value when there are no options. */
    empty?: string;
    hidden?: boolean;
  };

export interface FormButton { id: string; label: string; role: ThemeRole }

export interface FormState {
  /** The box's title (drawBox shows it upper-case). */
  title: string;
  fields: FormField[];
  /** The first is pressed by Enter on a field; `cancel` closes the dialog. */
  buttons: FormButton[];
  /** Index into `formRows(state)`. */
  cursor: number;
  error: string | null;
  /** While the pressed button's work runs: keys, typing and clicks are ignored. */
  busy: string | null;
}

export type FormRow = { kind: 'field'; field: FormField } | { kind: 'button'; button: FormButton };

export const visibleFormFields = (state: FormState): FormField[] => state.fields.filter((field) => !field.hidden);

export function formRows(state: FormState): FormRow[] {
  return [
    ...visibleFormFields(state).map((field): FormRow => ({ kind: 'field', field })),
    ...state.buttons.map((button): FormRow => ({ kind: 'button', button })),
  ];
}

/** The field under the cursor, or null on a button. */
export function focusedField(state: FormState): FormField | null {
  const row = formRows(state)[state.cursor];
  return row?.kind === 'field' ? row.field : null;
}

/** A text field is under the cursor: typed characters and pastes go into it. */
export const typingInForm = (state: FormState): boolean => !state.busy && focusedField(state)?.kind === 'text';

/** A field's value: a text field's text, a choice's choice. */
export function formValue(state: FormState, key: string): string {
  const field = state.fields.find((candidate) => candidate.key === key);
  if (!field) return '';
  return field.kind === 'text' ? field.text.value : field.value;
}

/** `state` with field `key` changed by `change`. */
export function withField(state: FormState, key: string, change: (field: FormField) => FormField): FormState {
  return { ...state, fields: state.fields.map((field) => (field.key === key ? change(field) : field)) };
}

export type FormKey = 'up' | 'down' | 'next' | 'previous' | 'left' | 'right' | 'space' | 'enter' | 'escape' | Exclude<TextFieldKey, 'left' | 'right'>;
/** A button's id when one was pressed, `cancel` to close; null for nothing. */
export interface FormStep { state: FormState; action: string | null }

const clamp = (state: FormState): FormState => ({ ...state, cursor: Math.max(0, Math.min(state.cursor, formRows(state).length - 1)) });

function cycle(state: FormState, field: Extract<FormField, { kind: 'choice' }>, delta: 1 | -1): FormState {
  if (field.options.length < 2) return state;
  const index = Math.max(0, field.options.indexOf(field.value));
  const value = field.options[(index + delta + field.options.length) % field.options.length];
  return clamp({ ...withField(state, field.key, (candidate) => ({ ...candidate, value }) as FormField), error: null });
}

function press(state: FormState, button: FormButton | undefined): FormStep {
  if (!button) return { state, action: null };
  return { state, action: button.id };
}

/** What a key does: move, edit a text field, change a choice, press a button, or cancel. */
export function formKey(state: FormState, key: FormKey): FormStep {
  if (state.busy) return { state, action: null };
  const rows = formRows(state);
  const row = rows[state.cursor];
  const move = (delta: number): FormStep => ({ state: { ...state, cursor: (state.cursor + delta + rows.length) % rows.length }, action: null });
  switch (key) {
    case 'escape': return { state, action: 'cancel' };
    case 'up': case 'previous': return move(-1);
    case 'down': case 'next': return move(1);
    case 'enter': return row?.kind === 'button' ? press(state, row.button) : press(state, state.buttons[0]);
    default: break;
  }
  if (row?.kind === 'field' && row.field.kind === 'text') {
    const field = row.field;
    if (key === 'space') return formType(state, ' ');
    const textKey: TextFieldKey = key;
    return { state: { ...withField(state, field.key, () => ({ ...field, text: textFieldKey(field.text, textKey) })), error: null }, action: null };
  }
  const delta = key === 'left' ? -1 : key === 'right' || key === 'space' ? 1 : 0;
  if (delta === 0) return { state, action: null };
  if (row?.kind === 'field' && row.field.kind === 'choice') return { state: cycle(state, row.field, delta), action: null };
  return move(delta);
}

/** Typed or pasted text: into the text field under the cursor; nothing elsewhere. */
export function formType(state: FormState, text: string): FormStep {
  const field = focusedField(state);
  if (state.busy || field?.kind !== 'text') return { state, action: null };
  return { state: { ...withField(state, field.key, () => ({ ...field, text: textFieldInsert(field.text, text) })), error: null }, action: null };
}

// ── layout and drawing ─────────────────────────────────────────────────────────

const DIALOG_COLS = 52;
export const FORM_LABEL_COLS = 12;
const BUTTON_GAP = 2;

export interface FormLayout {
  box: Region;
  /** The y of each shown field, in `visibleFormFields` order. */
  fieldY: number[];
  /** The x where a field's value starts, and its width. */
  valueX: number;
  valueCols: number;
  noteY: number;
  buttonsY: number;
  buttonX: Array<{ id: string; x: number; cols: number }>;
}

/** The box: a border row, a blank row, the fields, a blank row, the note row, the buttons and the border row; centred, at most 52 columns. */
export function formLayout(state: FormState, cols: number, rows: number): FormLayout {
  const fields = visibleFormFields(state);
  const width = Math.min(cols, DIALOG_COLS);
  const height = Math.min(rows, fields.length + 6);
  const box = { x: Math.max(0, Math.floor((cols - width) / 2)), y: Math.max(0, Math.floor((rows - height) / 2)), cols: width, rows: height };
  const buttonsY = box.y + box.rows - 2;
  let x = box.x + 3;
  const buttonX = state.buttons.map((button) => {
    const at = { id: button.id, x, cols: stringWidth(button.label) };
    x += at.cols + BUTTON_GAP;
    return at;
  });
  const valueX = box.x + 2 + FORM_LABEL_COLS;
  return {
    box, fieldY: fields.map((_, index) => box.y + 2 + index), valueX, valueCols: Math.max(1, box.x + box.cols - 2 - valueX),
    noteY: buttonsY - 1, buttonsY, buttonX,
  };
}

/** What a click does: a field takes the cursor (a click on a choice's value changes it), a button is pressed. */
export function formClick(state: FormState, layout: FormLayout, x: number, y: number): FormStep {
  if (state.busy) return { state, action: null };
  const index = layout.fieldY.indexOf(y);
  if (index >= 0) {
    const focused = { ...state, cursor: index };
    const field = visibleFormFields(state)[index];
    if (field.kind === 'choice' && x >= layout.valueX) return { state: cycle(focused, field, 1), action: null };
    return { state: focused, action: null };
  }
  if (y !== layout.buttonsY) return { state, action: null };
  const hit = layout.buttonX.find((button) => x >= button.x && x < button.x + button.cols);
  if (!hit) return { state, action: null };
  const cursor = formRows(state).findIndex((row) => row.kind === 'button' && row.button.id === hit.id);
  return press({ ...state, cursor }, state.buttons.find((button) => button.id === hit.id));
}

/**
 * Draws the form over `frame` (the app dims what is behind it first): the
 * cursor's row in `row.cursor`, text fields underlined with the caret shown
 * while focused, choices as `‹ value ›`, the note (`error`, or `text.muted`
 * while busy) and the buttons, the one under the cursor in `tab.active`.
 */
export function drawForm(frame: Frame, layout: FormLayout, state: FormState, theme: Theme, panel: CellStyle['bg']): void {
  const { box } = layout;
  fillRect(frame, box, { ...styleOf(theme, 'text.primary'), bg: panel });
  drawBox(frame, box, { title: state.title, focused: true, theme });
  const onPanel = (style: CellStyle): CellStyle => (style.bg.type === 'default' ? { ...style, bg: panel } : style);
  const focused = focusedField(state);
  visibleFormFields(state).forEach((field, index) => {
    const y = layout.fieldY[index];
    if (y >= layout.noteY) return;
    const cursor = field === focused;
    const label = onPanel(styleOf(theme, cursor ? 'row.cursor' : 'text.muted'));
    if (cursor) fillRect(frame, { x: box.x + 1, y, cols: box.cols - 2, rows: 1 }, label);
    drawText(frame, box.x + 2, y, field.label, label, FORM_LABEL_COLS - 1);
    const value = onPanel(styleOf(theme, 'text.primary'));
    if (field.kind === 'text') {
      drawTextField(frame, layout.valueX, y, layout.valueCols, field.text, {
        focused: cursor && !state.busy, style: { ...value, underline: true },
        ...(field.placeholder ? { placeholder: field.placeholder } : {}), placeholderStyle: { ...onPanel(styleOf(theme, 'text.muted')), underline: true },
      });
      return;
    }
    const shown = field.options.length === 0 ? field.empty ?? '' : field.options.length > 1 ? `‹ ${field.value} ›` : field.value;
    const style = field.options.length === 0 ? onPanel(styleOf(theme, 'text.muted')) : cursor ? { ...value, bg: label.bg, bold: true } : value;
    drawText(frame, layout.valueX, y, shown, style, layout.valueCols);
  });
  const note = state.busy ?? state.error;
  if (note && layout.noteY > box.y) drawText(frame, box.x + 2, layout.noteY, note, onPanel(styleOf(theme, state.busy ? 'text.muted' : 'error')), box.cols - 4);
  const rows = formRows(state);
  const under = rows[state.cursor];
  for (const { id, x } of layout.buttonX) {
    const button = state.buttons.find((candidate) => candidate.id === id)!;
    const style = under?.kind === 'button' && under.button.id === id ? styleOf(theme, 'tab.active') : onPanel(styleOf(theme, button.role));
    drawText(frame, x, layout.buttonsY, button.label, style, box.x + box.cols - 1 - x);
  }
}
