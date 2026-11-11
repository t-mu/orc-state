/**
 * lib/cockpit2/screen.ts — the screen model of one cockpit2 pane.
 *
 * One `@xterm/headless` emulator per pane. A viewer usually attaches after the
 * pane's program started, so the screen is first made right from tmux
 * (`restore` the `capture-pane -e` snapshots, `seedModes` from the pane's mode
 * flags) and then kept right by the `%output` stream (`write`).
 *
 * Bracketed paste (2004) is not reported: tmux has no pane format for it, so a
 * late-attached screen cannot know it. Pastes do not need it, because
 * `paste-buffer -p` adds the brackets exactly when the app enabled the mode.
 *
 * Modes the emulator does not expose (mouse encoding, cursor visibility) are
 * tracked with parser hooks on DECSET/DECRST, so seeded and streamed changes
 * go through the same path and the later one wins.
 */
import xtermHeadless from '@xterm/headless';
import type { IBufferCell, IDisposable, IUnicodeVersionProvider } from '@xterm/headless';
import { codePointWidth } from '../cellWidth.ts';

const { Terminal } = xtermHeadless;
const ESC = '\x1b';

// ── cell widths ───────────────────────────────────────────────────────────────

const AFTER_ZWJ = 1;
const ODD_FLAG = 2;
const isFlag = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
/** xterm's packed char properties: (state << 3) | (width << 1) | shouldJoin. */
const props = (state: number, width: number, join: boolean) => (state << 3) | ((width & 3) << 1) | (join ? 1 : 0);

/**
 * An xterm Unicode version provider that measures like lib/cellWidth.ts, so the
 * screen lays out text as frames and the renderer do. xterm's built-in Unicode
 * 6 tables count emoji as one column and do not join ZWJ sequences or flags;
 * here a ZWJ joins the next code point, a regional indicator pair joins, VS16
 * and a keycap widen, VS15 narrows.
 */
export const cellWidthUnicodeProvider: IUnicodeVersionProvider = {
  version: 'cellWidth',
  wcwidth: (cp) => codePointWidth(cp),
  charProperties(cp, preceding) {
    const own = codePointWidth(cp);
    const prevWidth = (preceding >> 1) & 3;
    const prevState = preceding >> 3;
    if (preceding !== 0 && prevState === AFTER_ZWJ) return props(cp === 0x200d ? AFTER_ZWJ : 0, prevWidth, true);
    if (preceding !== 0 && prevState === ODD_FLAG && isFlag(cp)) return props(0, 2, true);
    if (own === 0 && prevWidth > 0 && cp >= 0x20) {
      const width = cp === 0xfe0f || cp === 0x20e3 ? 2 : cp === 0xfe0e ? 1 : prevWidth;
      return props(cp === 0x200d ? AFTER_ZWJ : 0, width, true);
    }
    return props(isFlag(cp) ? ODD_FLAG : 0, own, false);
  },
};

/** A pane's terminal modes as tmux reports them (pane format flags); tmuxControl's `PaneReport` extends it. */
export interface PaneModes {
  alternateOn: boolean;
  /**
   * Some mouse mode is on (tmux `mouse_any_flag`). With neither `mouseButton`
   * nor `mouseStandard` it means all-motion tracking (1003).
   */
  mouseAny: boolean;
  /** Button-event tracking, 1002 (`mouse_button_flag`). */
  mouseButton: boolean;
  /** Normal tracking, 1000 (`mouse_standard_flag`). */
  mouseStandard: boolean;
  mouseSgr: boolean;
  mouseUtf8: boolean;
  /** Application cursor keys (DECCKM). */
  keypadCursor: boolean;
  cursorVisible: boolean;
}

export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export type MouseEncoding = 'default' | 'utf8' | 'sgr';

/** Modes a late-attached screen knows; bracketed paste is left out on purpose (see the file comment). */
export interface ScreenModes {
  mouseTracking: MouseTracking;
  mouseEncoding: MouseEncoding;
  applicationCursorKeys: boolean;
  cursorVisible: boolean;
  alternateScreen: boolean;
}

export type Color =
  | { type: 'default' }
  | { type: 'palette'; index: number }
  | { type: 'rgb'; r: number; g: number; b: number };

export interface CellStyle {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  fg: Color;
  bg: Color;
}

export interface Cell {
  /** The cell's grapheme (base plus combining marks); '' for the right half of a wide char. */
  text: string;
  /** 1, 2 for a wide char's left half, 0 for its right half. */
  width: number;
  style: CellStyle;
}

export interface Cursor { x: number; y: number; visible: boolean }

/**
 * A pane's screen as tmux captures it (`capture-pane -p -e`), one entry per line.
 * On the alternate screen `lines` is the alternate screen and `main` the main
 * screen tmux keeps under it (`capture-pane -a`); off it `main` is absent.
 */
export interface Snapshot {
  lines: readonly string[];
  main?: readonly string[];
}

export interface Screen {
  readonly cols: number;
  readonly rows: number;
  /** Feed pane output; resolves once it is parsed. */
  write(bytes: string | Uint8Array): Promise<void>;
  /**
   * Clear the screen and its scrollback and draw a snapshot, then place the
   * cursor. Lines above the last `rows` (pane history) go to the scrollback. With `main`,
   * the main screen is drawn first and the alternate screen entered over it, so
   * leaving the alternate screen (1049l) shows the main text again; without it
   * the main screen is drawn. Then seed modes (their screen switch is a no-op).
   */
  restore(snapshot: Snapshot, cursor: { x: number; y: number }): Promise<void>;
  /** Set the pane's modes as tmux reports them, by writing the equivalent DECSET/DECRST sequences. */
  seedModes(modes: PaneModes): Promise<void>;
  resize(cols: number, rows: number): void;
  /** The cell at (x, y) of the viewport (honours the scroll offset), or undefined outside it. */
  cell(x: number, y: number): Cell | undefined;
  /** Every cell of viewport row y (honours the scroll offset); [] outside the viewport. */
  row(y: number): Cell[];
  /** Whether viewport row y continues the row above it (a soft wrap); false outside the viewport. */
  wrapped(y: number): boolean;
  modes(): ScreenModes;
  cursor(): Cursor;
  /** Move the viewport: negative goes back into scrollback, positive towards the bottom. */
  scroll(delta: number): void;
  /** How many lines the viewport is above the bottom (0 = following output). */
  readonly scrollOffset: number;
  scrollToBottom(): void;
  dispose(): void;
}

export interface ScreenOptions { cols: number; rows: number; scrollback: number }

function colorOf(isDefault: boolean, isPalette: boolean, isRgb: boolean, value: number): Color {
  if (isPalette) return { type: 'palette', index: value };
  if (isRgb && !isDefault) return { type: 'rgb', r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  return { type: 'default' };
}

function styleOf(cell: IBufferCell): CellStyle {
  return {
    bold: Boolean(cell.isBold()),
    dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    blink: Boolean(cell.isBlink()),
    inverse: Boolean(cell.isInverse()),
    invisible: Boolean(cell.isInvisible()),
    strikethrough: Boolean(cell.isStrikethrough()),
    fg: colorOf(cell.isFgDefault(), cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor()),
    bg: colorOf(cell.isBgDefault(), cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor()),
  };
}

/** The DECSET/DECRST sequences that put an emulator into `modes`. */
export function modeSequences(modes: PaneModes): string {
  const set = (mode: number, on: boolean) => `${ESC}[?${mode}${on ? 'h' : 'l'}`;
  // The specific flags first: tmux's mouse_any_flag is also set for 1000 and 1002.
  const tracking = modes.mouseButton ? 1002 : modes.mouseStandard ? 1000 : modes.mouseAny ? 1003 : 0;
  const encoding = modes.mouseSgr ? 1006 : modes.mouseUtf8 ? 1005 : 0;
  return [
    tracking ? set(tracking, true) : set(1000, false),
    encoding ? set(encoding, true) : set(1006, false) + set(1005, false),
    set(1, modes.keypadCursor),
    set(25, modes.cursorVisible),
  ].join('');
}

export function createScreen({ cols, rows, scrollback }: ScreenOptions): Screen {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  term.unicode.register(cellWidthUnicodeProvider);
  term.unicode.activeVersion = cellWidthUnicodeProvider.version;
  let mouseEncoding: MouseEncoding = 'default';
  let cursorVisible = true;

  const onDecMode = (params: (number | number[])[], on: boolean): boolean => {
    for (const param of params) {
      if (param === 25) cursorVisible = on;
      else if (param === 1005 || param === 1006) {
        const encoding: MouseEncoding = param === 1006 ? 'sgr' : 'utf8';
        if (on) mouseEncoding = encoding;
        else if (mouseEncoding === encoding) mouseEncoding = 'default';
      }
    }
    return false; // let xterm apply the mode too
  };
  const hooks: IDisposable[] = [
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => onDecMode(params, true)),
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => onDecMode(params, false)),
    // RIS resets everything, mouse included.
    term.parser.registerEscHandler({ final: 'c' }, () => { mouseEncoding = 'default'; cursorVisible = true; return false; }),
    // DECSTR shows the cursor but, like xterm, keeps mouse tracking and its encoding.
    term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => { cursorVisible = true; return false; }),
  ];

  const write = (bytes: string | Uint8Array) => new Promise<void>((resolve) => term.write(bytes, resolve));

  const readCell = (line: ReturnType<typeof term.buffer.active.getLine>, x: number, scratch: IBufferCell): Cell | undefined => {
    const cell = line?.getCell(x, scratch);
    if (!cell) return undefined;
    const width = cell.getWidth();
    return { text: width === 0 ? '' : (cell.getChars() || ' '), width, style: styleOf(cell) };
  };
  const viewportLine = (y: number) => {
    if (y < 0 || y >= term.rows) return undefined;
    const buffer = term.buffer.active;
    return buffer.getLine(buffer.viewportY + y);
  };

  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    write,
    restore({ lines, main }, at) {
      const draw = (captured: readonly string[]) => `${ESC}[0m${ESC}[H${ESC}[2J${ESC}[3J${captured.join('\r\n')}${ESC}[0m`;
      const place = (x: number, y: number) => `${ESC}[${y + 1};${x + 1}H`;
      const leaveAlternate = term.buffer.active.type === 'alternate' ? `${ESC}[?1049l` : '';
      if (!main) return write(`${leaveAlternate}${draw(lines)}${place(at.x, at.y)}`);
      // tmux does not report the main screen's saved cursor. 1049h saves ours and
      // 1049l restores it, so park it where a shell continues after the command
      // that started the app: the line below the last non-blank one.
      let lastText = main.length - 1;
      while (lastText >= 0 && main[lastText].replace(/\x1b\[[0-9;:]*m/g, '').trim() === '') lastText--;
      const mainCursorY = Math.min(lastText + 1, term.rows - 1);
      return write(`${leaveAlternate}${draw(main)}${place(0, mainCursorY)}${ESC}[?1049h${draw(lines)}${place(at.x, at.y)}`);
    },
    seedModes(modes) {
      const alternate = term.buffer.active.type === 'alternate';
      const screenSwitch = modes.alternateOn === alternate ? '' : `${ESC}[?1049${modes.alternateOn ? 'h' : 'l'}`;
      return write(screenSwitch + modeSequences(modes));
    },
    resize(newCols, newRows) { term.resize(newCols, newRows); },
    cell(x, y) {
      if (x < 0 || x >= term.cols) return undefined;
      return readCell(viewportLine(y), x, term.buffer.active.getNullCell());
    },
    row(y) {
      const line = viewportLine(y);
      if (!line) return [];
      const scratch = term.buffer.active.getNullCell();
      const cells: Cell[] = [];
      for (let x = 0; x < term.cols; x++) {
        const cell = readCell(line, x, scratch);
        if (cell) cells.push(cell);
      }
      return cells;
    },
    wrapped(y) { return viewportLine(y)?.isWrapped ?? false; },
    modes() {
      const { modes } = term;
      return {
        mouseTracking: modes.mouseTrackingMode,
        mouseEncoding,
        applicationCursorKeys: modes.applicationCursorKeysMode,
        cursorVisible,
        alternateScreen: term.buffer.active.type === 'alternate',
      };
    },
    cursor() {
      const buffer = term.buffer.active;
      // xterm reports cursorX === cols while a wrap is pending; the cursor is drawn in the last column.
      const scrolledBack = buffer.baseY !== buffer.viewportY;
      return { x: Math.min(buffer.cursorX, term.cols - 1), y: buffer.cursorY, visible: cursorVisible && !scrolledBack };
    },
    scroll(delta) { term.scrollLines(delta); },
    get scrollOffset() {
      const buffer = term.buffer.active;
      return buffer.baseY - buffer.viewportY;
    },
    scrollToBottom() { term.scrollToBottom(); },
    dispose() {
      for (const hook of hooks) hook.dispose();
      term.dispose();
    },
  };
}
