/**
 * lib/cockpit2/textField.ts — a one-line text input for the cockpit's dialogs.
 *
 * Pure: a value and a caret (in graphemes), what an edit key or typed text
 * does to them, and how the field is drawn. Printable characters insert at
 * the caret; Backspace and Delete remove the grapheme before and under it;
 * Left, Right, Home and End move it; Ctrl-U clears the field. Typed and
 * pasted text loses its control characters (a paste's line breaks too), so
 * the value stays one line. A value wider than the field scrolls to keep
 * the caret in view; while focused the caret is a reverse cell.
 */
import { graphemeWidth, graphemes } from '../cellWidth.ts';
import { drawText, type Frame } from './frame.ts';
import type { CellStyle } from './screen.ts';

export interface TextFieldState {
  value: string;
  /** The caret, as an index into the value's graphemes: 0 before the first, `length` after the last. */
  caret: number;
}

/** A field holding `value`, the caret after it. */
export function textField(value = ''): TextFieldState {
  return { value, caret: graphemes(value).length };
}

export type TextFieldKey = 'left' | 'right' | 'home' | 'end' | 'backspace' | 'delete' | 'clear';

/** What an edit key does: move the caret, remove a grapheme, or clear the field. */
export function textFieldKey(state: TextFieldState, key: TextFieldKey): TextFieldState {
  const parts = graphemes(state.value);
  const caret = Math.max(0, Math.min(state.caret, parts.length));
  switch (key) {
    case 'left': return { ...state, caret: Math.max(0, caret - 1) };
    case 'right': return { ...state, caret: Math.min(parts.length, caret + 1) };
    case 'home': return { ...state, caret: 0 };
    case 'end': return { ...state, caret: parts.length };
    case 'clear': return { value: '', caret: 0 };
    case 'backspace':
      if (caret === 0) return state;
      return { value: [...parts.slice(0, caret - 1), ...parts.slice(caret)].join(''), caret: caret - 1 };
    case 'delete':
      if (caret >= parts.length) return state;
      return { value: [...parts.slice(0, caret), ...parts.slice(caret + 1)].join(''), caret };
  }
}

/** Typed or pasted text inserted at the caret, without its control characters (line breaks included). */
export function textFieldInsert(state: TextFieldState, text: string): TextFieldState {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  if (!clean) return state;
  const parts = graphemes(state.value);
  const caret = Math.max(0, Math.min(state.caret, parts.length));
  const added = graphemes(clean);
  return { value: [...parts.slice(0, caret), ...added, ...parts.slice(caret)].join(''), caret: caret + added.length };
}

/** The first grapheme shown in a field `cols` wide: the caret (and the cell it takes) stays inside. */
export function textFieldScroll(state: TextFieldState, cols: number): number {
  const parts = graphemes(state.value);
  const caret = Math.max(0, Math.min(state.caret, parts.length));
  // The caret's cell is one column wide at the end, else the grapheme under it.
  let used = caret < parts.length ? Math.max(1, graphemeWidth(parts[caret])) : 1;
  let start = caret;
  while (start > 0 && used + graphemeWidth(parts[start - 1]) <= cols) {
    start -= 1;
    used += graphemeWidth(parts[start]);
  }
  return start;
}

/**
 * Draws the field at (x, y), `cols` wide: its visible part in `style`, the
 * rest of the field filled in `style`; while `focused` the caret's cell in
 * `style` with `inverse` flipped. An empty unfocused field shows `placeholder`
 * in `placeholderStyle`.
 */
export function drawTextField(frame: Frame, x: number, y: number, cols: number, state: TextFieldState, options: {
  focused: boolean; style: CellStyle; placeholder?: string; placeholderStyle?: CellStyle;
}): void {
  if (cols <= 0) return;
  const { style } = options;
  drawText(frame, x, y, ' '.repeat(cols), style, cols);
  if (!state.value && !options.focused && options.placeholder) {
    drawText(frame, x, y, options.placeholder, options.placeholderStyle ?? style, cols);
    return;
  }
  const parts = graphemes(state.value);
  const caret = Math.max(0, Math.min(state.caret, parts.length));
  const start = options.focused ? textFieldScroll(state, cols) : 0;
  let col = x;
  for (let index = start; index < parts.length; index += 1) {
    const width = graphemeWidth(parts[index]);
    if (width === 0) continue;
    if (col + width > x + cols) break;
    const atCaret = options.focused && index === caret;
    drawText(frame, col, y, parts[index], atCaret ? { ...style, inverse: !style.inverse } : style, width);
    col += width;
  }
  if (options.focused && caret >= parts.length && col < x + cols) drawText(frame, col, y, ' ', { ...style, inverse: !style.inverse }, 1);
}
