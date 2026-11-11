/**
 * lib/cockpit2/app.ts — the cockpit2 app shell (Plan 6 Step 6).
 *
 * Draws the whole terminal: a sidebar (left, fixed width), a tab bar (top
 * right, fixed height) and the slot, which shows the current project's master
 * session. The master is reached directly through a tmux control client
 * (tmuxControl.ts) that owns its window and sizes it to the slot; its output
 * goes through a screen model (screen.ts) and is blitted into a frame
 * (frame.ts) that renderDiff (render.ts) turns into terminal output.
 *
 * Rendering happens only when something changed, at most once per frame
 * interval; an idle cockpit writes nothing. Keys typed go to the master as
 * bytes, pastes through `paste()`. The quit key (`C-q` by default) or the
 * prefix then `d` ends the app; the master, its workers and the coordinator
 * keep running. Sidebar and tab bar are placeholders that Step 9 replaces;
 * tabs and projects come with Step 7, the prefix table with Step 8, mouse
 * routing with Step 10.
 */
import { ControlClient, tmuxSessionTarget, type StatusView } from '../../client.ts';
import { keyLabel, type CockpitKeys } from '../cockpitKeys.ts';
import { DEFAULT_STYLE, blitScreen, createFrame, drawText, slotCursor, type Frame, type Region } from './frame.ts';
import { createTokenizer, keyMatcher, type Token } from './input.ts';
import { parseSgrMouse, type MouseEvent } from './mouse.ts';
import { renderDiff, sameStyle } from './render.ts';
import { createScreen, type Cursor, type Screen } from './screen.ts';
import type { TerminalSession } from './terminal.ts';
import { TmuxControlClient } from './tmuxControl.ts';

// ── layout ────────────────────────────────────────────────────────────────────

export const SIDEBAR_COLS = 34;
export const TAB_BAR_ROWS = 3;
/** The slot keeps at least this much; the sidebar and tab bar shrink first on a tiny terminal. */
const MIN_SLOT_COLS = 20;
const MIN_SLOT_ROWS = 3;

export type RegionName = 'sidebar' | 'tabBar' | 'slot';

export interface Layout {
  cols: number;
  rows: number;
  /** Left, full height. */
  sidebar: Region;
  /** Top right, above the slot. */
  tabBar: Region;
  /** The rest: the active tab's screen. */
  slot: Region;
}

/** The regions of a `cols` by `rows` terminal: the sidebar's width and the tab bar's height stay fixed while there is room. */
export function computeLayout(cols: number, rows: number): Layout {
  const sidebarCols = Math.min(SIDEBAR_COLS, Math.max(0, cols - MIN_SLOT_COLS));
  const tabBarRows = Math.min(TAB_BAR_ROWS, Math.max(0, rows - MIN_SLOT_ROWS));
  const rightCols = Math.max(0, cols - sidebarCols);
  return {
    cols,
    rows,
    sidebar: { x: 0, y: 0, cols: sidebarCols, rows },
    tabBar: { x: sidebarCols, y: 0, cols: rightCols, rows: tabBarRows },
    slot: { x: sidebarCols, y: tabBarRows, cols: rightCols, rows: Math.max(0, rows - tabBarRows) },
  };
}

const inside = (region: Region, x: number, y: number) =>
  x >= region.x && y >= region.y && x < region.x + region.cols && y < region.y + region.rows;

/** The region at frame cell (x, y) and the cell relative to that region; null outside every region. */
export function hitTest(layout: Layout, x: number, y: number): { region: RegionName; x: number; y: number } | null {
  for (const name of ['sidebar', 'tabBar', 'slot'] as const) {
    const region = layout[name];
    if (inside(region, x, y)) return { region: name, x: x - region.x, y: y - region.y };
  }
  return null;
}

/** What a mouse event in a region does; Steps 9 and 10 fill these in. */
export type MouseHandlers = Partial<Record<RegionName, (event: MouseEvent, at: { x: number; y: number }) => void>>;

/** Hands a mouse event to the handler of the region under it; returns that region, or null. */
export function dispatchMouse(layout: Layout, event: MouseEvent, handlers: MouseHandlers): RegionName | null {
  const hit = hitTest(layout, event.x, event.y);
  if (!hit) return null;
  handlers[hit.region]?.(event, { x: hit.x, y: hit.y });
  return hit.region;
}

// ── the master's tmux target ─────────────────────────────────────────────────

export interface MasterTarget { socket: string; session: string }

/**
 * The master's tmux socket and session: the status view's when it carries
 * them, else computed from the project's state directory (the coordinator may
 * be stopped; the master's session still runs on orc's tmux server).
 */
export function masterTarget(stateDir: string, status: Pick<StatusView, 'master'> | null): MasterTarget {
  const master = status?.master;
  if (master?.tmux_socket && master.tmux_session) return { socket: master.tmux_socket, session: master.tmux_session };
  return tmuxSessionTarget(stateDir, master?.agent_id ?? 'master');
}

/** `masterTarget` with the status view read from the project's coordinator, when one answers. */
export async function resolveMasterTarget(
  stateDir: string,
  fetchStatus: () => Promise<Pick<StatusView, 'master'>> = () => new ControlClient(stateDir, { timeoutMs: 2000 }).status(),
): Promise<MasterTarget> {
  const status = await fetchStatus().catch(() => null);
  return masterTarget(stateDir, status);
}

// ── the app ───────────────────────────────────────────────────────────────────

/** The part of a tmux control client the app uses; tests pass a fake. */
export type PaneClient = Pick<TmuxControlClient, 'on' | 'resize' | 'paneModes' | 'capture' | 'sendBytes' | 'paste' | 'close'>;

export interface AppOptions {
  terminal: TerminalSession;
  /** The tmux binary, resolved by the CLI layer. */
  tmuxBinary: string;
  /** orc's data home and the cockpit lock, from the CLI layer: the view state (Step 7) and the single-instance lock (Step 12) live there. */
  dataHome: string;
  lockPath: string;
  projectName: string;
  target: MasterTarget;
  keys: CockpitKeys;
  /** Opens the owned control client of the master's session (default: a `TmuxControlClient` on `tmuxBinary`). */
  connect?: (target: MasterTarget) => PaneClient;
  /** Scrollback lines kept for the master's screen (default 1000). */
  scrollback?: number;
  /** The shortest time between two frames (default 16 ms). */
  frameMs?: number;
  /** How long a layout change waits before the screen is captured again (default 50 ms). */
  resyncDelayMs?: number;
}

export interface App {
  /** Resolves once the app has quit and the terminal is restored. */
  readonly done: Promise<void>;
  quit(): void;
}

const MUTED_STYLE = { ...DEFAULT_STYLE, dim: true };
const TITLE_STYLE = { ...DEFAULT_STYLE, bold: true };

function drawBox(frame: Frame, region: Region, title: string): void {
  if (region.cols < 2 || region.rows < 2) return;
  const right = region.x + region.cols - 1;
  const bottom = region.y + region.rows - 1;
  const horizontal = '─'.repeat(region.cols - 2);
  drawText(frame, region.x, region.y, `╭${horizontal}╮`, MUTED_STYLE);
  drawText(frame, region.x, bottom, `╰${horizontal}╯`, MUTED_STYLE);
  for (let y = region.y + 1; y < bottom; y++) {
    drawText(frame, region.x, y, '│', MUTED_STYLE);
    drawText(frame, right, y, '│', MUTED_STYLE);
  }
  if (title && region.cols > 4) drawText(frame, region.x + 2, region.y, ` ${title} `, TITLE_STYLE, region.cols - 4);
}

/** How to quit, as the tab bar shows it. */
export function quitHint(keys: CockpitKeys): string {
  return [...(keys.quit ? [`${keyLabel(keys.quit)}: quit`] : []), `${keyLabel(keys.prefix)} d: quit`].join(' · ');
}

/** The placeholder tab bar: the master tab and how to quit (Step 9 draws the real one). */
function drawTabBar(frame: Frame, region: Region, keys: CockpitKeys): void {
  if (region.cols === 0 || region.rows === 0) return;
  const label = ' master ';
  const hintRow = region.y + Math.min(1, region.rows - 1);
  let used = 0;
  if (region.rows >= 3 && region.cols > label.length + 2) {
    const line = '─'.repeat(label.length);
    drawText(frame, region.x, region.y, `╭${line}╮`, MUTED_STYLE);
    drawText(frame, region.x, region.y + 1, '│', MUTED_STYLE);
    drawText(frame, region.x + 1, region.y + 1, label, TITLE_STYLE);
    drawText(frame, region.x + label.length + 1, region.y + 1, '│', MUTED_STYLE);
    drawText(frame, region.x, region.y + 2, `┘${' '.repeat(label.length)}└${'─'.repeat(Math.max(0, region.cols - label.length - 2))}`, MUTED_STYLE);
    used = label.length + 3;
  }
  const hint = quitHint(keys);
  const room = region.cols - used;
  if (room > 0) drawText(frame, region.x + Math.max(used, region.cols - hint.length - 1), hintRow, hint, MUTED_STYLE, room);
}

function drawMessage(frame: Frame, region: Region, lines: string[]): void {
  lines.forEach((line, index) => {
    if (index + 1 < region.rows) drawText(frame, region.x + 1, region.y + 1 + index, line, index === 0 ? TITLE_STYLE : MUTED_STYLE, region.cols - 2);
  });
}

function framesEqual(a: Frame, b: Frame): boolean {
  if (a.cols !== b.cols || a.rows !== b.rows) return false;
  for (let i = 0; i < a.cells.length; i++) {
    const x = a.cells[i];
    const y = b.cells[i];
    if (x.text !== y.text || x.width !== y.width || !sameStyle(x.style, y.style)) return false;
  }
  return true;
}

const sameCursor = (a: Cursor, b: Cursor) => a.x === b.x && a.y === b.y && a.visible === b.visible;

/** Starts the cockpit on an opened terminal; it runs until `quit()`, the quit key or prefix then `d`. */
export function runApp(options: AppOptions): App {
  const { terminal, keys, target } = options;
  const frameMs = options.frameMs ?? 16;
  const resyncDelayMs = options.resyncDelayMs ?? 50;
  const connect = options.connect
    ?? ((at: MasterTarget) => new TmuxControlClient({ tmuxBinary: options.tmuxBinary, socket: at.socket, session: at.session, ignoreSize: false }));

  let layout = computeLayout(terminal.size().cols, terminal.size().rows);
  let prevFrame: Frame | null = null;
  let prevCursor: Cursor | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRender = 0;
  let closed = false;
  /** Only the slot exists to focus until Step 9 makes the sidebar focusable. */
  const focus: RegionName = 'slot';

  // The master pane. Its output goes through `chain`, so writes, restores and resizes apply in arrival order.
  let screen: Screen | null = null;
  let paneId: string | null = null;
  /** Why the master is not shown (attaching, or its session ended); null while it is live. */
  let message: string[] | null = [`Attaching to the master (tmux -L ${target.socket}, session ${target.session})…`];
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void> | void): Promise<void> => {
    chain = chain.then(op).catch((error: unknown) => fail(error));
    return chain;
  };
  /**
   * Output while the screen is captured: `drop` before the capture's reply
   * (the capture already shows it), `hold` after it until the restore is
   * applied, `live` otherwise.
   */
  let outputMode: 'drop' | 'hold' | 'live' = 'drop';
  let held: Buffer[] = [];
  let syncing = false;
  let syncAgain = false;
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  // ── rendering ──
  function render(): void {
    renderTimer = null;
    if (closed) return;
    lastRender = Date.now();
    const frame = createFrame(layout.cols, layout.rows);
    drawBox(frame, layout.sidebar, options.projectName);
    drawTabBar(frame, layout.tabBar, keys);
    let cursor: Cursor = { x: 0, y: 0, visible: false };
    if (message || !screen) {
      drawMessage(frame, layout.slot, message ?? []);
    } else {
      blitScreen(frame, screen, layout.slot);
      cursor = slotCursor(screen, layout.slot, focus === 'slot');
    }
    if (prevFrame && prevCursor && framesEqual(prevFrame, frame) && sameCursor(prevCursor, cursor)) return;
    terminal.write(renderDiff(prevFrame, frame, cursor));
    prevFrame = frame;
    prevCursor = cursor;
  }

  /** Renders soon: bursts of changes within one frame interval become one frame. */
  function scheduleRender(): void {
    if (closed || renderTimer) return;
    renderTimer = setTimeout(render, Math.max(0, lastRender + frameMs - Date.now()));
  }

  // ── the master pane ──
  const client = connect(target);
  const paneTarget = () => paneId ?? `=${target.session}:`;

  let exited = false;
  function fail(error: unknown): void {
    // After %exit every pending command fails too; the exit message says why.
    if (closed || exited) return;
    message = ['The master is not shown.', error instanceof Error ? error.message : String(error),
      'Start it with orc start-session.', quitHint(keys)];
    scheduleRender();
  }

  /**
   * Late-attach restore: the pane's modes, its capture (with the main screen
   * kept under an alternate one), restore, seed modes, then the output that
   * arrived after the capture, then live output.
   */
  async function sync(): Promise<void> {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      do {
        syncAgain = false;
        outputMode = 'drop';
        held = [];
        const modes = await client.paneModes(`=${target.session}:`);
        paneId = modes.paneId;
        const main = modes.alternateOn ? await client.capture(modes.paneId, { saved: true }) : undefined;
        const lines = await client.capture(modes.paneId);
        // Output emitted before this point is in the capture. (Output that came in the same read
        // as the capture's reply is emitted before this continuation runs, so it is dropped too;
        // the program's next redraw covers that narrow window.)
        outputMode = 'hold';
        await enqueue(async () => {
          if (!screen) screen = createScreen({ cols: modes.cols, rows: modes.rows, scrollback: options.scrollback ?? 1000 });
          else if (screen.cols !== modes.cols || screen.rows !== modes.rows) screen.resize(modes.cols, modes.rows);
          await screen.restore(main ? { lines, main } : { lines }, { x: modes.cursorX, y: modes.cursorY });
          await screen.seedModes(modes);
        });
        for (const bytes of held.splice(0)) writeLive(bytes);
        outputMode = 'live';
        message = null;
        scheduleRender();
      } while (syncAgain && !closed);
    } finally {
      syncing = false;
    }
  }

  /** Captures the screen again shortly: after a layout change tmux has reflowed the pane, which its output does not replay. */
  function requestSync(): void {
    if (closed) return;
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => { resyncTimer = null; sync().catch(fail); }, resyncDelayMs);
  }

  /** Live output not yet handed to the screen: a burst becomes one write, not one queued write per `%output`. */
  let unwritten: Buffer[] = [];
  const writeLive = (bytes: Buffer) => {
    unwritten.push(bytes);
    if (unwritten.length > 1) return; // a write of the batch is already queued
    void enqueue(() => {
      const batch = Buffer.concat(unwritten);
      unwritten = [];
      return screen!.write(batch);
    }).then(scheduleRender);
  };
  client.on('output', (pane, bytes) => {
    if (closed || pane !== paneId || outputMode === 'drop') return;
    if (outputMode === 'hold') held.push(bytes);
    else writeLive(bytes);
  });
  client.on('notification', (line) => {
    if (line.startsWith('%layout-change')) requestSync();
  });
  client.on('exit', (reason) => {
    if (closed) return;
    exited = true;
    message = ['The master\'s tmux session is not running.', `tmux: ${reason}`, 'Start it with orc start-session.', quitHint(keys)];
    scheduleRender();
  });

  /** Sizes the master's window to the slot: the master tab owns its window. */
  const sizeToSlot = () => client.resize(Math.max(1, layout.slot.cols), Math.max(1, layout.slot.rows));
  sizeToSlot().then(() => sync()).catch(fail);

  // ── input ──
  const matchQuit = keyMatcher(keys.quit ? [keys.quit] : []);
  const matchPrefix = keyMatcher([keys.prefix]);
  const matchDetach = keyMatcher(['d']);
  let prefixPending = false;
  /** Steps 9 and 10 fill these in: sidebar and tab bar clicks, pane mouse routing. */
  const mouseHandlers: MouseHandlers = {};

  const forward = (bytes: Buffer) => {
    if (!message) client.sendBytes(paneTarget(), bytes).catch(fail);
  };

  function onToken(token: Token): void {
    if (closed) return;
    // A sequence cut short is never typed into the pane as text.
    if (token.kind === 'incomplete') return;
    if (token.kind === 'mouse') {
      const event = parseSgrMouse(token);
      if (event) dispatchMouse(layout, event, mouseHandlers);
      return;
    }
    if (token.kind === 'paste') {
      if (!message) client.paste(paneTarget(), token.data.toString('utf8')).catch(fail);
      return;
    }
    if (prefixPending) {
      prefixPending = false;
      if (matchDetach(token)) quit();
      else if (matchPrefix(token)) forward(token.raw); // the prefix twice reaches the pane
      // The rest of the prefix table comes with Step 8.
      return;
    }
    if (matchQuit(token)) { quit(); return; }
    if (matchPrefix(token)) { prefixPending = true; return; }
    forward(token.raw);
  }

  const tokenizer = createTokenizer({ onFlush: (tokens) => tokens.forEach(onToken) });
  const stopInput = terminal.onInput((chunk) => tokenizer.push(chunk).forEach(onToken));
  const stopResize = terminal.onResize(() => {
    const { cols, rows } = terminal.size();
    layout = computeLayout(cols, rows);
    sizeToSlot().catch(fail);
    scheduleRender();
  });

  function quit(): void {
    if (closed) return;
    closed = true;
    for (const timer of [renderTimer, resyncTimer]) if (timer) clearTimeout(timer);
    tokenizer.flush();
    stopInput();
    stopResize();
    // Closing the control client detaches it; the master's session keeps running.
    client.close();
    screen?.dispose();
    terminal.restore();
    resolveDone();
  }

  scheduleRender();
  return { done, quit };
}
