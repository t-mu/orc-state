/**
 * lib/cockpit2/helpDialog.ts — the help dialog (the leader then `?`): every
 * cockpit key with the configured key labels, drawn on the dialog layer as
 * the confirmation is (confirmDialog.ts: over the dimmed frame, centred), and
 * scrolled when it is taller than the terminal.
 *
 * Pure: the lines, what a key does to the dialog, its layout and drawing. The
 * app (app.ts) opens it and routes every key and click to it while it is open.
 */
import { COCKPIT_ACTIONS, keyLabel, type CockpitKeys } from '../cockpitKeys.ts';
import { fitText } from '../tui/sidebar.ts';
import { drawBox } from './chrome.ts';
import { drawText, fillRect, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { styleOf, type Theme } from './theme.ts';

/** A help line: a section heading, or a key and what it does. */
export type HelpLine = { heading: string } | { key: string; text: string };

export interface HelpDialogState {
  /** The lines, built once from the keys when the dialog opens. */
  lines: HelpLine[];
  /** The first line shown. */
  scroll: number;
}

/** Every cockpit key as configured: the leader's table, the direct keys, then the sidebar, tab strip, pane and dialog keys. */
export function helpLines(keys: CockpitKeys): HelpLine[] {
  const leader = keyLabel(keys.prefix);
  const tabKeys = COCKPIT_ACTIONS.filter((action) => action.startsWith('tab')).map((action) => keys.direct[action]);
  const defaultTabs = tabKeys.every((key, index) => key === `F${index + 1}`);
  const direct: HelpLine[] = [
    ...(defaultTabs ? [{ key: 'F1-F9', text: 'tab 1-9' }]
      : tabKeys.flatMap((key, index) => (key ? [{ key: keyLabel(key), text: `tab ${index + 1}` }] : []))),
    ...(keys.direct.dashboard ? [{ key: keyLabel(keys.direct.dashboard), text: 'sidebar (from the sidebar: the pane)' }] : []),
    ...(keys.direct.attention ? [{ key: keyLabel(keys.direct.attention), text: 'next agent needing attention' }] : []),
    ...(keys.quit ? [{ key: keyLabel(keys.quit), text: 'quit the cockpit' }] : []),
  ];
  return [
    { heading: `Leader: ${leader}, then` },
    { key: '← → / h l', text: 'previous / next tab (stays armed)' },
    { key: '1-9', text: 'tab 1-9' },
    { key: 'Tab / Shift-Tab', text: 'next / previous container: pane, tab strip, sidebar (stays armed)' },
    { key: 's', text: 'sidebar (from the sidebar: the pane)' },
    { key: 'p', text: 'pane' },
    { key: 'w', text: 'close the current tab' },
    { key: 't', text: 'new shell tab' },
    { key: 'a', text: 'new agent' },
    { key: 'n / N', text: 'next / previous project' },
    { key: 'e', text: 'task explorer' },
    { key: ',', text: 'project settings' },
    { key: '!', text: 'next agent needing attention' },
    { key: 'i', text: 'type into the worker or scout tab, or stop' },
    { key: '?', text: 'this help' },
    { key: 'q', text: 'quit the cockpit' },
    { key: 'Esc', text: 'nothing (the leader disarms)' },
    { key: leader, text: `send ${leader} to the pane` },
    ...(direct.length > 0 ? [{ heading: 'Direct keys' }, ...direct] : []),
    { heading: 'Sidebar' },
    { key: '↑ ↓ / j k', text: 'move' },
    { key: 'Tab / Shift-Tab', text: 'next / previous card' },
    { key: 'Enter', text: 'open, press a button, expand or collapse' },
    { key: 'Space / → ← / l h', text: 'expand or collapse an agent' },
    { key: 'x', text: 'kill the agent (asks first)' },
    { key: 'Esc', text: 'pane' },
    { heading: 'Tab strip' },
    { key: '← →', text: 'move' },
    { key: 'Enter', text: 'show the tab (on +: a new shell)' },
    { key: 'w / Delete', text: 'close the tab' },
    { key: 'Esc / ↓', text: 'pane' },
    { heading: 'Pane' },
    { key: 'any key', text: 'reaches the master, a shell or an agent session' },
    { key: 'i', text: 'type into a worker or scout tab' },
    { key: 'q Esc Ctrl-D Ctrl-C', text: 'close a worker or scout tab in view mode' },
    { key: 'Ctrl-]', text: 'stop typing; close the task explorer' },
    { heading: 'Dialogs' },
    { key: '↑ ↓ Tab / j k', text: 'move' },
    { key: '← → Space / h l', text: 'change' },
    { key: 'Enter', text: 'press the button under the cursor' },
    { key: 'Esc / q', text: 'cancel' },
  ];
}

export function openHelpDialog(keys: CockpitKeys): HelpDialogState {
  return { lines: helpLines(keys), scroll: 0 };
}

export type HelpKey = 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end' | 'close';
export interface HelpStep { state: HelpDialogState; close: boolean }

const DIALOG_COLS = 72;
/** Columns between the box's border and its text, each side. */
const PAD = 2;
/** Rows of the box around its lines: the two borders and a blank row above and below. */
const CHROME_ROWS = 4;
/** The key column's width: the longest key (`q Esc Ctrl-D Ctrl-C`) and two blanks; a longer configured key label is cut. */
const KEY_COLS = 21;

export interface HelpLayout {
  box: Region;
  /** The y of the first line. */
  linesY: number;
  /** How many lines fit. */
  visible: number;
}

/** The box: centred, at most 72 columns, as tall as the lines or the frame. */
export function helpDialogLayout(state: HelpDialogState, cols: number, rows: number): HelpLayout {
  const width = Math.min(cols, DIALOG_COLS);
  const height = Math.min(rows, state.lines.length + CHROME_ROWS);
  const box = { x: Math.max(0, Math.floor((cols - width) / 2)), y: Math.max(0, Math.floor((rows - height) / 2)), cols: width, rows: height };
  return { box, linesY: box.y + 2, visible: Math.max(1, height - CHROME_ROWS) };
}

/** What a key does: scroll (kept in range for `layout`), or close. */
export function helpDialogKey(state: HelpDialogState, layout: HelpLayout, key: HelpKey): HelpStep {
  if (key === 'close') return { state, close: true };
  const max = Math.max(0, state.lines.length - layout.visible);
  const delta = { up: -1, down: 1, pageUp: -layout.visible, pageDown: layout.visible, home: -Infinity, end: Infinity }[key];
  const scroll = Math.max(0, Math.min(max, state.scroll + delta));
  return { state: scroll === state.scroll ? state : { ...state, scroll }, close: false };
}

/**
 * Draws the dialog over `frame` (the app dims what is behind it first): a box
 * in the panel colour titled `help`, headings in `chrome.title`, keys in
 * `text.accent`, what they do in `text.primary`; `↑`/`↓` on the right border
 * while there are lines above or below.
 */
export function drawHelpDialog(frame: Frame, layout: HelpLayout, state: HelpDialogState, theme: Theme, panel: CellStyle['bg']): void {
  const { box } = layout;
  fillRect(frame, box, { ...styleOf(theme, 'text.primary'), bg: panel });
  drawBox(frame, box, { title: 'help', meta: 'Esc: close', focused: true, theme });
  const onPanel = (style: CellStyle): CellStyle => (style.bg.type === 'default' ? { ...style, bg: panel } : style);
  const inner = box.cols - 2 * PAD;
  if (inner <= 0) return;
  const shown = state.lines.slice(state.scroll, state.scroll + layout.visible);
  shown.forEach((line, index) => {
    const y = layout.linesY + index;
    if (y >= box.y + box.rows - 1) return;
    if ('heading' in line) {
      drawText(frame, box.x + PAD, y, fitText(line.heading, inner), onPanel(styleOf(theme, 'chrome.title')), inner);
      return;
    }
    const keyCols = Math.min(KEY_COLS, inner);
    drawText(frame, box.x + PAD, y, fitText(line.key, keyCols - 1), onPanel(styleOf(theme, 'text.accent')), keyCols - 1);
    if (inner > keyCols) drawText(frame, box.x + PAD + keyCols, y, fitText(line.text, inner - keyCols), onPanel(styleOf(theme, 'text.primary')), inner - keyCols);
  });
  const right = box.x + box.cols - 1;
  const muted = onPanel(styleOf(theme, 'text.muted'));
  if (state.scroll > 0 && box.rows > 2) drawText(frame, right, box.y + 1, '↑', muted, 1);
  if (state.scroll + layout.visible < state.lines.length && box.rows > 2) drawText(frame, right, box.y + box.rows - 2, '↓', muted, 1);
}
