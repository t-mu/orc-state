import { describe, expect, it } from 'vitest';
import { DEFAULT_COCKPIT_KEYS, resolveCockpitKeys } from '../cockpitKeys.ts';
import { createFrame } from './frame.ts';
import { drawHelpDialog, helpDialogKey, helpDialogLayout, helpLines, openHelpDialog } from './helpDialog.ts';
import { BUILT_IN_THEMES } from './theme.ts';

const text = (lines: ReturnType<typeof helpLines>) => lines.map((line) => ('heading' in line ? `# ${line.heading}` : `${line.key}: ${line.text}`));

describe('helpLines', () => {
  it('lists the leader table, the direct keys, the sidebar, tab strip, pane and dialog keys with the configured labels', () => {
    const lines = text(helpLines(DEFAULT_COCKPIT_KEYS));
    expect(lines.filter((line) => line.startsWith('# '))).toEqual([
      '# Leader: Ctrl-Space, then', '# Direct keys', '# Sidebar', '# Tab strip', '# Pane', '# Dialogs',
    ]);
    for (const line of ['q: quit the war room', '?: this help', 'Ctrl-Space: send Ctrl-Space to the pane', 'F1-F9: tab 1-9', 'F10: sidebar (from the sidebar: the pane)', 'F11: next agent needing attention']) {
      expect(lines).toContain(line);
    }
    // No direct quit key by default.
    expect(lines.filter((line) => line.endsWith('quit the war room'))).toEqual(['q: quit the war room']);
  });

  it('follows ORC_COCKPIT_PREFIX and ORC_COCKPIT_KEYS', () => {
    const { keys } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'C-a', ORC_COCKPIT_KEYS: 'tab1=M-1,attention=none,quit=C-q' });
    const lines = text(helpLines(keys));
    expect(lines[0]).toBe('# Leader: Ctrl-a, then');
    expect(lines).toContain('Alt-1: tab 1');
    expect(lines).toContain('F2: tab 2');
    expect(lines).toContain('Ctrl-q: quit the war room');
    expect(lines.some((line) => line.startsWith('F11'))).toBe(false);
  });
});

describe('the help dialog', () => {
  it('fits a tall terminal whole and scrolls in a short one, kept in range', () => {
    const state = openHelpDialog(DEFAULT_COCKPIT_KEYS);
    const tall = helpDialogLayout(state, 100, 80);
    expect(tall.visible).toBe(state.lines.length);
    expect(tall.box.cols).toBe(72);
    expect(helpDialogKey(state, tall, 'down').state.scroll).toBe(0);
    const short = helpDialogLayout(state, 80, 24);
    expect(short.box.rows).toBe(24);
    expect(short.visible).toBe(20);
    const max = state.lines.length - 20;
    expect(helpDialogKey(state, short, 'down').state.scroll).toBe(1);
    expect(helpDialogKey(state, short, 'up').state.scroll).toBe(0);
    expect(helpDialogKey(state, short, 'pageDown').state.scroll).toBe(Math.min(20, max));
    expect(helpDialogKey(state, short, 'end').state.scroll).toBe(max);
    expect(helpDialogKey({ ...state, scroll: max }, short, 'home').state.scroll).toBe(0);
    expect(helpDialogKey(state, short, 'close')).toEqual({ state, close: true });
  });

  it('draws its lines from the scroll position, with ↓ while more follow and ↑ once scrolled', () => {
    const state = openHelpDialog(DEFAULT_COCKPIT_KEYS);
    const layout = helpDialogLayout(state, 80, 24);
    const row = (frame: ReturnType<typeof createFrame>, y: number) => frame.cells.slice(y * 80, (y + 1) * 80).map((cell) => cell.text).join('');
    const top = createFrame(80, 24);
    drawHelpDialog(top, layout, state, BUILT_IN_THEMES.orc, { type: 'default' });
    expect(row(top, layout.linesY)).toContain('Leader: Ctrl-Space, then');
    expect(row(top, 0)).toContain('[ HELP ]');
    expect(row(top, 22).trimEnd().endsWith('↓')).toBe(true);
    expect(row(top, 1).trimEnd().endsWith('↑')).toBe(false);
    const scrolled = createFrame(80, 24);
    drawHelpDialog(scrolled, layout, { ...state, scroll: 1 }, BUILT_IN_THEMES.orc, { type: 'default' });
    expect(row(scrolled, layout.linesY)).toContain('← → / h l');
    expect(row(scrolled, 1).trimEnd().endsWith('↑')).toBe(true);
  });
});
