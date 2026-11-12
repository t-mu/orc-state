import { describe, expect, it } from 'vitest';
import { badgeText, collapseMarker, drawBadge, drawBox, drawPaneBox, type BoxOptions, type PaneHeader } from './chrome.ts';
import { cellAt, createFrame, DEFAULT_STYLE, drawText, type Frame, type Region } from './frame.ts';
import { BUILT_IN_THEMES, STATUS_ROLES, badgeRole, styleOf, type BuiltInThemeName } from './theme.ts';

const THEMES = Object.keys(BUILT_IN_THEMES) as BuiltInThemeName[];

/** Row `y` as text (a wide grapheme's continuation cell adds nothing). */
const rowText = (frame: Frame, y: number) =>
  Array.from({ length: frame.cols }, (_, x) => cellAt(frame, x, y)!.text).join('');
const frameText = (frame: Frame) => Array.from({ length: frame.rows }, (_, y) => rowText(frame, y));

/** Every wide cell is followed by its continuation and every continuation follows a wide cell. */
function expectValid(frame: Frame): void {
  for (let y = 0; y < frame.rows; y++) {
    for (let x = 0; x < frame.cols; x++) {
      const cell = cellAt(frame, x, y)!;
      if (cell.width === 2) expect(cellAt(frame, x + 1, y)?.width, `continuation after ${x},${y}`).toBe(0);
      if (cell.width === 0) expect(cellAt(frame, x - 1, y)?.width, `wide cell before ${x},${y}`).toBe(2);
    }
  }
}

/** Every cell outside `region` is still the frame's untouched blank. */
function expectUntouchedOutside(frame: Frame, region: Region): void {
  for (let y = 0; y < frame.rows; y++) {
    for (let x = 0; x < frame.cols; x++) {
      const inside = x >= region.x && x < region.x + region.cols && y >= region.y && y < region.y + region.rows;
      if (inside) continue;
      const cell = cellAt(frame, x, y)!;
      expect(cell.text, `${x},${y}`).toBe(' ');
      expect(cell.style, `${x},${y}`).toBe(DEFAULT_STYLE);
    }
  }
}

/** A box drawn on a 2-cell margin inside a larger frame. */
function boxed(cols: number, rows: number, options: Omit<BoxOptions, 'theme'>, theme: BuiltInThemeName = 'amber') {
  const frame = createFrame(cols + 4, rows + 2);
  const region = { x: 2, y: 1, cols, rows };
  const inner = drawBox(frame, region, { ...options, theme: BUILT_IN_THEMES[theme] });
  return { frame, region, inner };
}

describe('drawBox', () => {
  it('draws the glyph reference at width 34', () => {
    const { frame, region, inner } = boxed(34, 4, { title: 'agents', meta: '3 live' });
    expect(frameText(frame).slice(1, 5).map((line) => line.slice(2, 36))).toEqual([
      '┌─ [ AGENTS ] ─────────── 3 live ┐',
      '│                                │',
      '│                                │',
      '└────────────────────────────────┘',
    ]);
    expect(inner).toEqual({ x: 3, y: 2, cols: 32, rows: 2 });
    expectUntouchedOutside(frame, region);
    expectValid(frame);
  });

  it('keeps only the borders at width 10 and draws a plain box at width 4', () => {
    const ten = boxed(10, 3, { title: 'agents', meta: '3 live' });
    expect(frameText(ten.frame).slice(1, 4).map((line) => line.slice(2, 12))).toEqual(['┌────────┐', '│        │', '└────────┘']);
    expectUntouchedOutside(ten.frame, ten.region);
    const four = boxed(4, 2, { title: 'agents', meta: '3 live' });
    expect(frameText(four.frame).slice(1, 3).map((line) => line.slice(2, 6))).toEqual(['┌──┐', '└──┘']);
    expect(four.inner).toEqual({ x: 3, y: 2, cols: 2, rows: 0 });
    expectUntouchedOutside(four.frame, four.region);
  });

  it('shows a short title at width 10', () => {
    const { frame } = boxed(10, 2, { title: 'a' });
    expect(rowText(frame, 1).slice(2, 12)).toBe('┌─ [ A ] ┐');
  });

  it('drops a title whose cut keeps no text', () => {
    // 11 columns leave the title 2 columns: a wide first grapheme cannot fit beside the ellipsis.
    const wide = boxed(11, 2, { title: '漢字x', meta: 'm' });
    expect(rowText(wide.frame, 1).slice(2, 13)).toBe('┌─────────┐');
    const narrow = boxed(11, 2, { title: 'abc' });
    expect(rowText(narrow.frame, 1).slice(2, 13)).toBe('┌─ [ A… ] ┐');
  });

  it('draws nothing in a region narrower than 4 or shorter than 2', () => {
    for (const [cols, rows] of [[3, 5], [10, 1], [0, 0]]) {
      const { frame, inner } = boxed(cols, rows, { title: 'x' });
      expectUntouchedOutside(frame, { x: 0, y: 0, cols: 0, rows: 0 });
      expect(inner).toEqual({ x: 2, y: 1, cols: 0, rows: 0 });
    }
  });

  it('drops the meta before cutting the title', () => {
    // Title and meta do not both fit: the meta goes, the title stays whole.
    const both = boxed(20, 2, { title: 'agents', meta: '3 live' });
    expect(rowText(both.frame, 1).slice(2, 22)).toBe('┌─ [ AGENTS ] ─────┐');
    // A long title is cut by display width; no meta beside a cut title.
    const long = boxed(20, 2, { title: 'other projects here', meta: '2' });
    expect(rowText(long.frame, 1).slice(2, 22)).toBe('┌─ [ OTHER PROJ… ] ┐');
  });

  it('drops a meta that does not fit whole', () => {
    const { frame } = boxed(30, 2, { title: 'agents', meta: 'twelve live and four idle' });
    expect(rowText(frame, 1).slice(2, 32)).toBe('┌─ [ AGENTS ] ───────────────┐');
  });

  it('shows the meta alone when there is no title', () => {
    const { frame } = boxed(16, 2, { meta: '3 live' });
    expect(rowText(frame, 1).slice(2, 18)).toBe('┌────── 3 live ┐');
  });

  it('never splits a wide grapheme in the title or the meta', () => {
    for (let cols = 4; cols <= 30; cols++) {
      const { frame, region } = boxed(cols, 3, { title: '漢字タイトル🚀', meta: '状態🙂' });
      expectValid(frame);
      expectUntouchedOutside(frame, region);
      const top = rowText(frame, 1);
      expect(top).not.toContain('�');
    }
    const { frame } = boxed(20, 2, { title: '漢字タイトル🚀' });
    expect(rowText(frame, 1).slice(2)).toBe('┌─ [ 漢字タイト… ] ┐  ');
  });

  it('never draws outside the region at any width', () => {
    for (let cols = 0; cols <= 40; cols++) {
      const { frame, region } = boxed(cols, 3, { title: 'other projects', meta: '12 live' });
      expectUntouchedOutside(frame, region);
      expectValid(frame);
    }
  });

  it('styles border, title and meta by role and focus', () => {
    const theme = BUILT_IN_THEMES.amber;
    const draw = (options: Omit<BoxOptions, 'theme'>) => {
      const frame = createFrame(34, 3);
      drawBox(frame, { x: 0, y: 0, cols: 34, rows: 3 }, { ...options, theme });
      return frame;
    };
    const plain = draw({ title: 'agents', meta: '3 live' });
    expect(cellAt(plain, 0, 0)!.style).toEqual(styleOf(theme, 'chrome.border'));
    expect(cellAt(plain, 0, 1)!.style).toEqual(styleOf(theme, 'chrome.border'));
    expect(cellAt(plain, 3, 0)!.style).toEqual(styleOf(theme, 'chrome.title'));
    expect(cellAt(plain, 5, 0)!.style).toEqual(styleOf(theme, 'chrome.title'));
    expect(cellAt(plain, 27, 0)!.style).toEqual(styleOf(theme, 'chrome.meta'));
    expect(cellAt(plain, 33, 2)!.style).toEqual(styleOf(theme, 'chrome.border'));

    const focused = draw({ title: 'agents', focused: true });
    expect(cellAt(focused, 0, 0)!.style).toEqual(styleOf(theme, 'chrome.borderFocus'));
    expect(cellAt(focused, 5, 0)!.style).toEqual(styleOf(theme, 'chrome.titleFocus'));

    const role = draw({ title: 'agents', role: 'status.attention', focused: true });
    expect(cellAt(role, 0, 0)!.style).toEqual(styleOf(theme, 'status.attention'));
    expect(cellAt(role, 33, 1)!.style).toEqual(styleOf(theme, 'status.attention'));
  });

  it('draws the same text in every built-in theme', () => {
    const cases: Array<[number, Omit<BoxOptions, 'theme'>]> = [
      [4, { title: 'agents' }], [10, { title: 'agents', meta: '3 live' }], [34, { title: 'agents', meta: '3 live', focused: true }],
      [20, { title: '漢字タイトル🚀', meta: 'x' }],
    ];
    for (const [cols, options] of cases) {
      const amber = frameText(boxed(cols, 3, options, 'amber').frame);
      for (const name of THEMES) expect(frameText(boxed(cols, 3, options, name).frame), `${name} at ${cols}`).toEqual(amber);
    }
  });
});

describe('drawBadge', () => {
  it('draws the label upper-cased in brackets in the badge style and returns its width', () => {
    for (const name of THEMES) {
      const theme = BUILT_IN_THEMES[name];
      const frame = createFrame(20, 1);
      expect(drawBadge(frame, 1, 0, 'input req', 'status.attention', theme)).toBe(11);
      expect(rowText(frame, 0)).toBe(' [INPUT REQ]        ');
      for (let x = 1; x < 12; x++) expect(cellAt(frame, x, 0)!.style).toEqual(styleOf(theme, 'status.attention.badge'));
      expect(cellAt(frame, 0, 0)!.style).toBe(DEFAULT_STYLE);
      expect(cellAt(frame, 12, 0)!.style).toBe(DEFAULT_STYLE);
    }
  });

  it('uses each status role\'s badge style', () => {
    const theme = BUILT_IN_THEMES.amber;
    for (const role of STATUS_ROLES) {
      const frame = createFrame(10, 1);
      drawBadge(frame, 0, 0, 'idle', role, theme);
      expect(cellAt(frame, 0, 0)!.style).toEqual(styleOf(theme, `${role}.badge`));
    }
  });

  it('draws nothing and returns 0 when it does not fit', () => {
    const frame = createFrame(10, 2);
    expect(drawBadge(frame, 2, 0, 'stopped', 'status.idle', BUILT_IN_THEMES.amber)).toBe(0); // needs 9, has 8
    expect(drawBadge(frame, 0, 0, 'stopped', 'status.idle', BUILT_IN_THEMES.amber, 8)).toBe(0);
    expect(drawBadge(frame, 0, 2, 'idle', 'status.idle', BUILT_IN_THEMES.amber)).toBe(0);
    expect(drawBadge(frame, -1, 0, 'idle', 'status.idle', BUILT_IN_THEMES.amber)).toBe(0);
    expect(frameText(frame)).toEqual(['          ', '          ']);
    expect(drawBadge(frame, 1, 1, 'stopped', 'status.idle', BUILT_IN_THEMES.amber, 9)).toBe(9);
    expect(rowText(frame, 1)).toBe(' [STOPPED]');
  });

  it('measures wide labels by display width', () => {
    const frame = createFrame(8, 1);
    expect(drawBadge(frame, 0, 0, '状態', 'status.warn', BUILT_IN_THEMES.mono, 5)).toBe(0);
    expect(drawBadge(frame, 0, 0, '状態', 'status.warn', BUILT_IN_THEMES.mono, 6)).toBe(6);
    expect(rowText(frame, 0)).toBe('[状態]  ');
    expectValid(frame);
  });
});

describe('badgeText', () => {
  it('upper-cases the label and shows the running state as ACTIVE', () => {
    expect(badgeText('running')).toBe('[ACTIVE]');
    expect(badgeText('coordinator running')).toBe('[COORDINATOR ACTIVE]');
    expect(badgeText('stopped')).toBe('[STOPPED]');
    expect(badgeText('done')).toBe('[DONE]');
  });
});

describe('collapseMarker', () => {
  it('is [-] expanded and [+] collapsed', () => {
    expect(collapseMarker(true)).toBe('[-]');
    expect(collapseMarker(false)).toBe('[+]');
  });
});

describe('drawPaneBox', () => {
  const theme = BUILT_IN_THEMES.amber;
  const header = (parts: string[], badge: PaneHeader['badge'] = null): PaneHeader => ({ title: 'w1', parts, badge });

  it('draws a full box with the title on its top border, leaving the inside and the rows outside alone', () => {
    const frame = createFrame(12, 6);
    drawText(frame, 0, 0, 'tab strip', DEFAULT_STYLE, 12);
    drawPaneBox(frame, { x: 0, y: 1, cols: 12, rows: 5 }, { title: 'w1', parts: [], badge: null }, true, theme);
    expect(frameText(frame)).toEqual([
      'tab strip   ',
      '┌─ [ W1 ] ─┐',
      `│${' '.repeat(10)}│`,
      `│${' '.repeat(10)}│`,
      `│${' '.repeat(10)}│`,
      `└${'─'.repeat(10)}┘`,
    ]);
    for (const [x, y] of [[0, 1], [11, 1], [0, 2], [11, 4], [0, 5], [11, 5]]) expect(cellAt(frame, x, y)!.style, `${x},${y}`).toEqual(styleOf(theme, 'chrome.borderFocus'));
    expect(cellAt(frame, 5, 3)!.style).toBe(DEFAULT_STYLE);
  });

  it('draws a plain box without a header', () => {
    const frame = createFrame(6, 3);
    drawPaneBox(frame, { x: 0, y: 0, cols: 6, rows: 3 }, null, false, theme);
    expect(frameText(frame)).toEqual(['┌────┐', '│    │', '└────┘']);
    expect(cellAt(frame, 0, 0)!.style).toEqual(styleOf(theme, 'chrome.border'));
  });

  it('joins the parts with ` · ` after the title in text.muted, and puts the badge flush right', () => {
    const frame = createFrame(50, 3);
    drawPaneBox(frame, { x: 0, y: 0, cols: 50, rows: 3 }, header(['task-1', 'implement'], { label: 'question', role: 'status.attention' }), false, theme);
    expect(rowText(frame, 0)).toBe(`┌─ [ W1 ] task-1 · implement ${'─'.repeat(7)} [QUESTION] ─┐`);
    expect(cellAt(frame, 10, 0)!.style).toEqual(styleOf(theme, 'text.muted'));
    expect(cellAt(frame, 37, 0)!.style).toEqual(styleOf(theme, badgeRole('status.attention')));
  });

  it('shows whole parts only, skipping empty ones, and stops at the first that does not fit', () => {
    const frame = createFrame(34, 3);
    drawPaneBox(frame, { x: 0, y: 0, cols: 34, rows: 3 }, header(['task-1', '', 'implement', 'x']), false, theme);
    expect(rowText(frame, 0)).toBe(`┌─ [ W1 ] task-1 · implement ${'─'.repeat(4)}┐`);
    const narrow = createFrame(30, 3);
    drawPaneBox(narrow, { x: 0, y: 0, cols: 30, rows: 3 }, header(['task-1', 'implement', 'x']), false, theme);
    expect(rowText(narrow, 0)).toBe(`┌─ [ W1 ] task-1 ${'─'.repeat(12)}┐`);
    expect(rowText(narrow, 0)).not.toContain('…');
  });

  it('keeps at least one `─` between the parts and the badge, and drops the badge before it meets the title', () => {
    const frame = createFrame(32, 3);
    const stalled = { label: 'stalled', role: 'status.warn' } as const;
    drawPaneBox(frame, { x: 0, y: 0, cols: 32, rows: 3 }, header(['task-1', 'implement'], stalled), false, theme);
    expect(rowText(frame, 0)).toBe('┌─ [ W1 ] task-1 ── [STALLED] ─┐');
    const tight = createFrame(18, 3);
    drawPaneBox(tight, { x: 0, y: 0, cols: 18, rows: 3 }, header(['task-1'], stalled), false, theme);
    expect(rowText(tight, 0)).toBe(`┌─ [ W1 ] ${'─'.repeat(7)}┐`);
    const long = createFrame(36, 3);
    drawPaneBox(long, { x: 0, y: 0, cols: 36, rows: 3 }, { title: 'worker-agent-long', parts: [], badge: stalled }, false, theme);
    expect(rowText(long, 0)).toBe(`┌─ [ WORKER-AGENT-LONG ] ${'─'.repeat(10)}┐`);
  });

  it('draws nothing for a region too small for a box', () => {
    const one = createFrame(4, 1);
    drawPaneBox(one, { x: 0, y: 0, cols: 4, rows: 1 }, header(['a']), false, theme);
    expect(rowText(one, 0)).toBe('    ');
    const narrow = createFrame(3, 3);
    drawPaneBox(narrow, { x: 0, y: 0, cols: 3, rows: 3 }, header(['a']), false, theme);
    expect(frameText(narrow)).toEqual(['   ', '   ', '   ']);
  });
});
