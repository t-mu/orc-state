import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, createFrame } from './frame.ts';
import { drawTextField, textField, textFieldInsert, textFieldKey, textFieldScroll } from './textField.ts';

describe('textField', () => {
  it('starts with the caret after the value', () => {
    expect(textField()).toEqual({ value: '', caret: 0 });
    expect(textField('abc')).toEqual({ value: 'abc', caret: 3 });
  });

  it('inserts typed text at the caret, dropping control characters and line breaks', () => {
    let state = textFieldInsert(textField(), '/rep');
    state = textFieldKey(state, 'left');
    state = textFieldInsert(state, 'X');
    expect(state).toEqual({ value: '/reXp', caret: 4 });
    expect(textFieldInsert(textField('a'), '/tmp/x\r\n\t\u001b')).toEqual({ value: 'a/tmp/x', caret: 7 });
    expect(textFieldInsert(textField('a'), '\n')).toEqual({ value: 'a', caret: 1 });
  });

  it('moves the caret with Left, Right, Home and End within the value', () => {
    const state = textField('abc');
    expect(textFieldKey(state, 'right').caret).toBe(3);
    expect(textFieldKey(state, 'left').caret).toBe(2);
    expect(textFieldKey(state, 'home').caret).toBe(0);
    expect(textFieldKey(textFieldKey(state, 'home'), 'left').caret).toBe(0);
    expect(textFieldKey({ value: 'abc', caret: 0 }, 'end').caret).toBe(3);
  });

  it('removes the grapheme before the caret on Backspace and under it on Delete; Ctrl-U clears', () => {
    expect(textFieldKey(textField('abc'), 'backspace')).toEqual({ value: 'ab', caret: 2 });
    expect(textFieldKey({ value: 'abc', caret: 0 }, 'backspace')).toEqual({ value: 'abc', caret: 0 });
    expect(textFieldKey({ value: 'abc', caret: 1 }, 'delete')).toEqual({ value: 'ac', caret: 1 });
    expect(textFieldKey(textField('abc'), 'delete')).toEqual({ value: 'abc', caret: 3 });
    expect(textFieldKey(textField('a😀b'), 'backspace')).toEqual({ value: 'a😀', caret: 2 });
    expect(textFieldKey(textField('abc'), 'clear')).toEqual({ value: '', caret: 0 });
  });

  it('scrolls a long value to keep the caret in view', () => {
    expect(textFieldScroll(textField('abcdefghij'), 5)).toBe(6);
    expect(textFieldScroll({ value: 'abcdefghij', caret: 2 }, 5)).toBe(0);
    expect(textFieldScroll(textField('ab'), 5)).toBe(0);
  });

  it('draws the value with the caret as a reverse cell while focused, a placeholder while empty and unfocused', () => {
    const frame = createFrame(10, 1);
    drawTextField(frame, 0, 0, 6, { value: 'abc', caret: 1 }, { focused: true, style: DEFAULT_STYLE });
    expect(frame.cells.slice(0, 6).map((cell) => cell.text).join('')).toBe('abc   ');
    expect(frame.cells.map((cell) => cell.style.inverse)).toEqual([false, true, false, false, false, false, false, false, false, false]);
    const end = createFrame(10, 1);
    drawTextField(end, 0, 0, 6, textField('abc'), { focused: true, style: DEFAULT_STYLE });
    expect(end.cells[3].style.inverse).toBe(true);
    const long = createFrame(10, 1);
    drawTextField(long, 0, 0, 4, textField('abcdefgh'), { focused: true, style: DEFAULT_STYLE });
    expect(long.cells.slice(0, 4).map((cell) => cell.text).join('')).toBe('fgh ');
    const empty = createFrame(10, 1);
    drawTextField(empty, 0, 0, 6, textField(), { focused: false, style: DEFAULT_STYLE, placeholder: '/path' });
    expect(empty.cells.slice(0, 6).map((cell) => cell.text).join('')).toBe('/path ');
    expect(empty.cells.some((cell) => cell.style.inverse)).toBe(false);
  });
});
