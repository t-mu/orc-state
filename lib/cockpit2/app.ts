/**
 * lib/cockpit2/app.ts — the cockpit2 app (Plan 6 Steps 6 to 11).
 *
 * Draws the whole terminal: a header row, a sidebar (left, fixed width), a
 * tab bar (right, fixed height), a footer row and the slot, which shows the active tab: a project's
 * master or an agent's session. Each open tab has its own tmux control client
 * and screen model (sessions.ts); only the shown one receives output, the
 * hidden ones are paused and restored when shown again. Screens are blitted
 * into a frame (frame.ts) that renderDiff (render.ts) turns into terminal output.
 *
 * Tabs and projects follow the pure transitions of lib/cockpitTabs.ts
 * (`apply`); projects and their status come from a `ProjectWatcher`
 * (`orc-state/client`); the view state is kept in the view-state file
 * (viewState.ts). The master is reached even while its coordinator is down,
 * through its last known or computed tmux target.
 *
 * Rendering happens only when something changed, at most once per frame
 * interval; an idle cockpit writes nothing. Input goes through the
 * dispatcher (dispatch.ts): cockpit keys and the prefix table, then the shown
 * tab's mode. The master tab takes keys directly; worker and scout tabs open
 * view-only and take keys only after `i`. Keys go to the pane as bytes, pastes
 * through `paste()`. The pane's cursor key mode is mirrored to the real
 * terminal. The quit key (`C-q` by default) or the prefix then `d` ends the
 * app; masters, workers and coordinators keep running, and closing a tab only
 * detaches its view.
 *
 * The terminal's top row is the header: the orc mark, the active project's
 * name, and flush right the task explorer entry and the count of agents
 * needing attention (both clickable). Its last row is the footer: the mode,
 * `project › tab` and the cockpit keys; a terminal too short drops the
 * footer, then the tab bar's borders, then the header, before the slot
 * shrinks. The header, the tab bar and the footer are drawn by widgets.ts,
 * the sidebar's Project, Other projects and Agents cards by sidebarCards.ts,
 * from the pure models of lib/tui. The keys belong to the slot or to a
 * sidebar box: the dashboard key (F10 by default) or the prefix then `o`
 * focus the sidebar, where arrows (or
 * j/k), Tab, Enter, Space and Esc navigate, open, expand or collapse an agent
 * and return to the pane. Clicks on a sidebar row open that project or agent
 * (on an agent's collapse marker expand or collapse it), on a header button open the
 * explorer or jump to attention, on a tab show it, on a tab's close
 * marker close it (only the view: the agent keeps running). What Enter or a
 * click opens takes the keys.
 *
 * The view state is saved on every tab change. Projects another process added
 * to the view-state file (a start-session from another checkout or from inside
 * the cockpit, instance.ts) are kept by every save and taken in on a
 * `reloadViewState()`, which also shows the project that process made active.
 *
 * Mouse events in the slot (mouse.ts `routeSlotMouse`) go to the pane's app
 * when its mouse mode wants them, re-encoded pane-relative in its encoding,
 * motion at most once per frame. A view-only agent tab forwards nothing, and
 * Shift held always gives the cockpit the event. The cockpit's events: the
 * wheel scrolls the pane's scrollback (which holds the pane's history from
 * before the attach), any key returns to live; a left drag selects text
 * (selection.ts), highlighted, and the release copies it with OSC 52. A press
 * in the slot keeps the mouse until its release, wherever the pointer goes.
 *
 * The task explorer (explorer.ts) is a tab of its own: the prefix then `t`,
 * or the header's `tasks` entry, starts it for the active project in a
 * session on the cockpit's private tmux server and shows it after the
 * project's tabs. It owns its keys: Esc, `q`, `h` and Backspace go back from
 * a task's detail, and `q` or Esc in its list quit it, which ends its session
 * and closes the tab. `Ctrl-]` or its `×` always close it (the session is
 * killed), and so does any tab change (a tab key, a click, the sidebar, the
 * attention key); the active tab is shown again. Its keys are sent one at a
 * time, each after the one before reached the pane and a short gap: Ink reads
 * keys that arrive together as one input, and the explorer would ignore it.
 * Agent tabs in typing mode get their keys as they come, in order but not
 * paced (Claude Code takes several characters in one read as typed text, and
 * pacing would slow fast typing); a paste is never split. While the explorer
 * shows a message instead of its screen (starting, failed), `q` or Esc close
 * it. Any change of the shown tab (another tab or project, the explorer, an
 * attention jump) returns the tab left to view mode. The attention key (F11) and the
 * header's attention badge (`! N`, the count of agents needing a human across
 * projects) show the next of those agents (`nextAttention`).
 */
import { tmuxSessionTarget, type ProjectConnectionState, type ProjectWatchState, type ProjectWatchUpdate, type StatusView } from '../../client.ts';
import {
  MASTER_TAB, closeTab, closedTabs, cycleProject, cycleTab, nextAttention, openAgent, selectTab, shownTab, showProject,
  type CockpitTabState, type OpenTab, type TabTransition,
} from '../cockpitTabs.ts';
import { keyLabel, type CockpitKeys } from '../cockpitKeys.ts';
import { ATTENTION_BADGE, buildSidebarModel, projectState } from '../tui/sidebar.ts';
import { buildProjectViews } from '../tui/status.ts';
import { buildTabBarModel, tabAttention, tabBarClickTarget } from '../tui/tabBarModel.ts';
import { blitScreen, createFrame, drawText, slotCursor, type Frame, type Region } from './frame.ts';
import { createDispatcher, cursorKeyMirror, modeNotice, type DispatchContext } from './dispatch.ts';
import type { ColorDepth } from './color.ts';
import { attentionQueue, type ExplorerHost } from './explorer.ts';
import { createTokenizer, type Token } from './input.ts';
import { createMotionCoalescer, encodeMouse, parseSgrMouse, routeSlotMouse, type MouseEvent } from './mouse.ts';
import { renderDiff, sameStyle } from './render.ts';
import type { Cursor, Screen } from './screen.ts';
import { DEFAULT_THEME, attentionRole, parseThemeColor, projectStateRole, styleOf, type Theme } from './theme.ts';
import { drawPaneBox, type PaneHeader } from './chrome.ts';
import { highlightSelection, osc52, selectionText, type CellPoint, type Selection } from './selection.ts';
import { Sessions, type ConnectPane, type PaneSession } from './sessions.ts';
import type { TerminalSession } from './terminal.ts';
import { TmuxControlClient } from './tmuxControl.ts';
import { MAX_SIDEBAR_COLS, MIN_SIDEBAR_COLS, mergeProjects, type TmuxTarget, type ViewState, type ViewStateStore } from './viewState.ts';
import {
  EXPLORER_LABEL, EXPLORER_TAB, drawFooter, drawHeader, drawTabBar, headerButtonAt, headerView, tabBarView,
  withExplorerTab, withModeMarks, type FooterHint, type HeaderButton,
} from './widgets.ts';
import {
  INITIAL_SIDEBAR_NAV, drawSidebarCards, navigateSidebar, pruneExpanded, sidebarCardClick, sidebarCardsLayout,
  type SidebarBox, type SidebarCommand, type SidebarNav, type SidebarStep,
} from './sidebarCards.ts';

// ── layout ────────────────────────────────────────────────────────────────────

export const SIDEBAR_COLS = 34;
/** The gutter between the sidebar and the tabs and pane: two columns from WIDE_COLS terminal columns, one from NARROW_COLS, else none. */
export const GUTTER_COLS = 2;
const WIDE_COLS = 100;
const NARROW_COLS = 60;
/** Two presses on the gutter within this many milliseconds reset the sidebar's width. */
const DOUBLE_CLICK_MS = 400;
export const TAB_BAR_ROWS = 4;
/** The header (top) and footer (bottom) rows, full width; dropped (footer first) before the slot shrinks below its minimum. */
export const HEADER_ROWS = 1;
export const FOOTER_ROWS = 1;
/** The slot keeps at least this much; the footer, the header, then the tab bar go first on a tiny terminal. */
const MIN_SLOT_COLS = 20;
const MIN_SLOT_ROWS = 3;
/** Lines one wheel notch scrolls a pane's scrollback. */
export const WHEEL_LINES = 3;

export type RegionName = 'header' | 'sidebar' | 'gutter' | 'tabBar' | 'slot' | 'footer';

export interface Layout {
  cols: number;
  rows: number;
  /** Top row, full width; zero rows when the terminal is too short. */
  header: Region;
  /** Left, between the header and the footer. */
  sidebar: Region;
  /** Between the sidebar and the tabs and pane: blank, and the handle that drags the sidebar's width. */
  gutter: Region;
  /** Right, below the header and above the slot. */
  tabBar: Region;
  /** The rest: the active tab's screen (inside the pane frame when there is one). */
  slot: Region;
  /**
   * The box around the slot, its top border on the row under the tab bar.
   * Null when the terminal has no room for it.
   */
  paneFrame: Region | null;
  /** Bottom row, full width; zero rows when the terminal is too short (dropped before the header). */
  footer: Region;
}

/**
 * The regions of a `cols` by `rows` terminal: the sidebar's width and the
 * tab bar's height stay fixed while there is room. Rows beyond the slot's
 * minimum go to the tabs' label row, then the header, then the tabs' other
 * rows, then the footer.
 */
export function computeLayout(cols: number, rows: number, sidebarWidth: number = SIDEBAR_COLS): Layout {
  // The gap between the sidebar and the tabs and pane, narrower on a narrow terminal; it is also the divider's handle.
  const gutterCols = cols >= WIDE_COLS ? GUTTER_COLS : cols >= NARROW_COLS ? 1 : 0;
  const sidebarCols = Math.min(sidebarWidth, Math.max(0, cols - MIN_SLOT_COLS - gutterCols));
  const gutter = sidebarCols > 0 ? gutterCols : 0;
  const rightX = sidebarCols + gutter;
  let spare = Math.max(0, rows - MIN_SLOT_ROWS);
  // The tabs' label row, then the header, then the rest of the tabs' height, then the footer.
  let tabBarRows = Math.min(1, spare);
  spare -= tabBarRows;
  const headerRows = Math.min(HEADER_ROWS, spare);
  spare -= headerRows;
  const fatRows = Math.min(TAB_BAR_ROWS - tabBarRows, spare);
  tabBarRows += fatRows;
  spare -= fatRows;
  const footerRows = Math.min(FOOTER_ROWS, spare);
  const rightCols = Math.max(0, cols - rightX);
  const middleRows = Math.max(0, rows - headerRows - footerRows);
  const slot = { x: rightX, y: headerRows + tabBarRows, cols: rightCols, rows: Math.max(0, middleRows - tabBarRows) };
  // The frame is a box around the slot: two columns and two rows.
  const framed = slot.cols - 2 >= MIN_SLOT_COLS && slot.rows - 2 >= MIN_SLOT_ROWS;
  return {
    cols,
    rows,
    header: { x: 0, y: 0, cols, rows: headerRows },
    sidebar: { x: 0, y: headerRows, cols: sidebarCols, rows: middleRows },
    gutter: { x: sidebarCols, y: headerRows, cols: gutter, rows: middleRows },
    tabBar: { x: rightX, y: headerRows, cols: rightCols, rows: tabBarRows },
    slot: framed ? { x: slot.x + 1, y: slot.y + 1, cols: slot.cols - 2, rows: slot.rows - 2 } : slot,
    paneFrame: framed ? slot : null,
    footer: { x: 0, y: rows - footerRows, cols, rows: footerRows },
  };
}

const inside = (region: Region, x: number, y: number) =>
  x >= region.x && y >= region.y && x < region.x + region.cols && y < region.y + region.rows;

/** The region at frame cell (x, y) and the cell relative to that region; null outside every region. */
export function hitTest(layout: Layout, x: number, y: number): { region: RegionName; x: number; y: number } | null {
  for (const name of ['header', 'sidebar', 'gutter', 'tabBar', 'slot', 'footer'] as const) {
    const region = layout[name];
    if (inside(region, x, y)) return { region: name, x: x - region.x, y: y - region.y };
  }
  return null;
}

/** What a mouse event in a region does. */
export type MouseHandlers = Partial<Record<RegionName, (event: MouseEvent, at: { x: number; y: number }) => void>>;

/** Hands a mouse event to the handler of the region under it; returns that region, or null. */
export function dispatchMouse(layout: Layout, event: MouseEvent, handlers: MouseHandlers): RegionName | null {
  const hit = hitTest(layout, event.x, event.y);
  if (!hit) return null;
  handlers[hit.region]?.(event, { x: hit.x, y: hit.y });
  return hit.region;
}

// ── tmux targets ─────────────────────────────────────────────────────────────

/** What the app knows about a project for finding its tmux targets. */
export interface ProjectInfo {
  /** Its state directory; null when the registry does not list it (only a stored target is known then). */
  stateDir: string | null;
  /** Its coordinator answers. */
  running: boolean;
  /** The latest status view (possibly stale while the coordinator is down). */
  status: Pick<StatusView, 'master' | 'worker_capacity' | 'scouts'> | null;
}

/**
 * The master's tmux socket and session, in this order: the status view's
 * while the coordinator runs; the target stored in the view state while it is
 * down; else computed from the project's state directory (the master's
 * session still runs on orc's tmux server). Null when none is known.
 */
export function masterTarget(project: ProjectInfo, stored: TmuxTarget | null): TmuxTarget | null {
  const master = project.status?.master;
  if (project.running && master?.tmux_socket && master.tmux_session) return { socket: master.tmux_socket, session: master.tmux_session };
  if (stored) return stored;
  return project.stateDir ? tmuxSessionTarget(project.stateDir, master?.agent_id ?? 'master') : null;
}

/**
 * A worker's or scout's tmux target: the status view's, else computed from the
 * state directory. Null for a session that is not on tmux, or when neither is known.
 */
export function agentTarget(project: ProjectInfo, agentId: string): TmuxTarget | null {
  const entry = [...(project.status?.worker_capacity?.slots ?? []), ...(project.status?.scouts ?? [])]
    .find((agent) => agent.agent_id === agentId);
  if (entry?.tmux_socket && entry.tmux_session) return { socket: entry.tmux_socket, session: entry.tmux_session };
  if (entry?.session_handle && !entry.session_handle.startsWith('tmux:')) return null;
  return project.stateDir ? tmuxSessionTarget(project.stateDir, agentId) : null;
}

/** A tab's session key. */
export const tabKey = (tab: OpenTab) => `${tab.projectId}\0${tab.agentId ?? ''}`;
/** The task explorer's session key; tab keys always hold a NUL, so it never equals one. */
export const EXPLORER_KEY = 'explorer';

/** The task explorer while it is shown: its project, its session once started, or why it did not start. */
interface ExplorerState { projectId: string; target: TmuxTarget | null; error: string | null }

/** What the slot says about the task explorer while it has no screen to show, or null when its screen is shown. */
export function explorerMessage(explorer: ExplorerState, session: Pick<PaneSession, 'state' | 'error' | 'screen'> | null, keys: CockpitKeys): string[] | null {
  if (explorer.error) return ['The task explorer did not start.', explorer.error, 'q or Esc closes this tab.', quitHint(keys)];
  if (session?.state.kind === 'ended') return ['The task explorer ended.', `tmux: ${session.state.reason}`, 'q or Esc closes this tab.'];
  if (session?.error) return ['The task explorer is not shown.', session.error, 'q or Esc closes this tab.'];
  if (!explorer.target || !session?.screen) return [`Starting the task explorer for ${explorer.projectId}…`];
  return null;
}

// ── the app ───────────────────────────────────────────────────────────────────

/** The part of a `ProjectWatcher` the app reads; the CLI layer starts and stops it. */
export type ProjectSource = { projects(): ProjectWatchState[]; onUpdate(listener: (update: ProjectWatchUpdate) => void): () => void };

export interface AppOptions {
  terminal: TerminalSession;
  /** The tmux binary, resolved by the CLI layer. */
  tmuxBinary: string;
  /** The view-state file (`cockpit/view-state.json` under orc's data home). */
  store: ViewStateStore;
  /** Registered projects and their status. */
  projects: ProjectSource;
  /** The project to show on start (added when the view state does not have it). */
  projectId: string;
  keys: CockpitKeys;
  /** Opens a tab's control client (default: a `TmuxControlClient` on `tmuxBinary`). */
  connect?: ConnectPane;
  /** Scrollback lines kept per screen (default 1000). */
  scrollback?: number;
  /** The shortest time between two frames (default 16 ms). */
  frameMs?: number;
  /** How long a layout change waits before the screen is captured again (default 50 ms). */
  resyncDelayMs?: number;
  /** How often the sidebar's run times are brought up to date (default 30 s); a render with no change writes nothing. */
  tickMs?: number;
  /** Starts and stops the task explorer's sessions (explorer.ts `tmuxExplorerHost`); without one the explorer cannot open. */
  explorer?: ExplorerHost | undefined;
  /** The outer terminal's colour depth (color.ts `colorDepthFromEnv`, from the CLI layer; default `truecolor`). */
  colorDepth?: ColorDepth | undefined;
  /** The theme everything the cockpit draws itself is styled with (theme.ts `themeFromEnv`, from the CLI layer; default `amber`). */
  theme?: Theme | undefined;
  /** The pause after each key sent to the task explorer before the next one (default 4 ms). */
  explorerKeyGapMs?: number;
}

/** Why the app ended: the user quit, or another cockpit took over (instance.ts). */
export type AppExit = 'quit' | 'takeover';

export interface App {
  /** Resolves once the app has quit, the terminal is restored and the view state saved, with why it ended. */
  readonly done: Promise<AppExit>;
  /** Why the last view-state save failed; null once one succeeds. The CLI reports it after the terminal is restored. */
  saveError(): string | null;
  /** Ends the app; `takeover` when another cockpit asked it to exit. */
  quit(reason?: AppExit): void;
  /**
   * Reads the view state again: projects another process added are kept and,
   * when that process made one of them active, shown (a start-session adding
   * its project to this cockpit). The CLI calls it on a wake-up.
   */
  reloadViewState(): void;
  /** Applies a tab transition (lib/cockpitTabs.ts). A refused one changes nothing. */
  apply(transition: (state: CockpitTabState) => TabTransition): TabTransition;
  /** The current tabs and projects. */
  tabs(): CockpitTabState;
}

/** How to quit, as the slot's messages show it. */
export function quitHint(keys: CockpitKeys): string {
  return [...(keys.quit ? [`${keyLabel(keys.quit)}: quit`] : []), `${keyLabel(keys.prefix)} d: quit`].join(' · ');
}

/**
 * The footer's key hints from the resolved keys: quit (the quit key, else
 * the prefix then d), the dashboard key (else the prefix then o) and the attention key (left
 * out when it has no direct key).
 */
export function footerHints(keys: CockpitKeys): FooterHint[] {
  const { dashboard, attention } = keys.direct;
  return [
    keys.quit ? { key: keyLabel(keys.quit), action: 'quit' } : { key: `${keyLabel(keys.prefix)} d`, action: 'quit' },
    { key: dashboard ? keyLabel(dashboard) : `${keyLabel(keys.prefix)} o`, action: 'dashboard' },
    ...(attention ? [{ key: keyLabel(attention), action: 'attention' }] : []),
  ];
}

/** Where the keys go: the slot (the shown tab) or a sidebar box. */
export type Focus = 'slot' | SidebarBox;

function drawMessage(frame: Frame, region: Region, lines: string[], theme: Theme): void {
  lines.forEach((line, index) => {
    if (index + 1 < region.rows) drawText(frame, region.x + 1, region.y + 1 + index, line, styleOf(theme, index === 0 ? 'chrome.title' : 'text.muted'), region.cols - 2);
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
const sameTarget = (a: TmuxTarget | null | undefined, b: TmuxTarget | null) =>
  a === b || (!!a && !!b && a.socket === b.socket && a.session === b.session);

/** What the slot says about a tab that has no screen to show, or null when its screen is shown. */
export interface SlotContext {
  tab: OpenTab | null;
  /** The project's name, repository and coordinator connection, when the registry lists it. */
  project: { name: string; repoRoot: string; connection: ProjectConnectionState } | null;
  target: TmuxTarget | null;
  session: Pick<PaneSession, 'state' | 'error' | 'screen'> | null;
  keys: CockpitKeys;
}

export function slotMessage({ tab, project, target, session, keys }: SlotContext): string[] | null {
  if (!tab) return ['No project is open.', 'Run orc start-session in a project.', quitHint(keys)];
  const who = tab.agentId === null ? 'The master' : tab.agentId;
  const startCommand = `Start it with: ${project ? `cd ${project.repoRoot} && ` : ''}orc start-session`;
  if (!target) {
    if (!project) return [`Project ${tab.projectId} is not registered.`, quitHint(keys)];
    return [`${who} does not run in tmux, so the cockpit cannot show it.`, quitHint(keys)];
  }
  const state = session?.state ?? { kind: 'attaching' as const };
  if (state.kind === 'ended') {
    if (tab.agentId !== null) return [`${who}'s tmux session is not running.`, `tmux: ${state.reason}`, quitHint(keys)];
    if (project?.connection === 'stopped') return [`Project ${project.name} is not running.`, startCommand, `tmux: ${state.reason}`, quitHint(keys)];
    // The coordinator is up (or not known yet): it may be restarting the master, so no start command.
    const coordinator = project ? `Coordinator: ${project.connection}.` : 'The project is not registered.';
    return ['The master\'s tmux session is not running.', `tmux: ${state.reason}`, coordinator, quitHint(keys)];
  }
  if (session?.error) return [`${who} is not shown.`, session.error, quitHint(keys)];
  if (state.kind === 'attaching' || !session?.screen) return [`Attaching to ${tab.agentId === null ? 'the master' : tab.agentId} (tmux -L ${target.socket}, session ${target.session})…`];
  return null;
}

/** Starts the cockpit on an opened terminal; it runs until `quit()`, the quit key or prefix then `d`. */
export function runApp(options: AppOptions): App {
  const { terminal, keys, store } = options;
  const theme = options.theme ?? DEFAULT_THEME;
  const frameMs = options.frameMs ?? 16;
  const connect: ConnectPane = options.connect
    ?? ((target, { ignoreSize }) => new TmuxControlClient({ tmuxBinary: options.tmuxBinary, socket: target.socket, session: target.session, ignoreSize }));

  /** The sidebar's width as dragged (from the view state), or the default. */
  let sidebarWidth = SIDEBAR_COLS;
  let layout = computeLayout(terminal.size().cols, terminal.size().rows);
  /** The divider while it is dragged: the column the sidebar would end at, and the press that grabbed it. */
  let dividerDrag: { x: number; pressX: number; startX: number } | null = null;
  let lastGutterPress = 0;
  let prevFrame: Frame | null = null;
  let prevCursor: Cursor | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRender = 0;
  let closed = false;
  let focus: Focus = 'slot';
  let nav: SidebarNav = INITIAL_SIDEBAR_NAV;
  /** Why the last tab transition was refused; shown in the tab bar until the next input. */
  let refusal: string | null = null;
  let registryError: string | null = null;

  let resolveDone!: (exit: AppExit) => void;
  const done = new Promise<AppExit>((resolve) => { resolveDone = resolve; });

  // ── view state ──
  const loaded = store.load();
  if (loaded.sidebarCols !== undefined) {
    sidebarWidth = loaded.sidebarCols;
    layout = computeLayout(terminal.size().cols, terminal.size().rows, sidebarWidth);
  }
  let tabs = showProject(loaded.tabs, options.projectId).state;
  const masterTargets: ViewState['masterTargets'] = { ...loaded.masterTargets };
  let saving: Promise<void> = Promise.resolve();
  let lastSaveError: string | null = null;
  /** The active project the view-state file held after this cockpit's last read or write: another writer changed it when the file differs. */
  let syncedActive: string | null = loaded.tabs.activeProject;
  /**
   * Saves the view state after the saves before it, through the store's locked
   * read-change-write: this cockpit's tabs replace the stored ones, except that
   * projects another writer added are kept (and taken into this cockpit, see
   * `adopt`); master targets are merged. A failed save leaves the file as it
   * was and is shown in the tab bar; the next save retries.
   */
  const save = () => {
    saving = saving
      .then(() => {
        let seen: { tabs: CockpitTabState; synced: string | null } | null = null;
        return store.update((stored) => {
          const next = mergeProjects(tabs, stored.tabs);
          seen = { tabs: stored.tabs, synced: syncedActive };
          syncedActive = next.activeProject;
          const sidebar = sidebarWidth === SIDEBAR_COLS ? {} : { sidebarCols: sidebarWidth };
          return { tabs: next, masterTargets: { ...stored.masterTargets, ...masterTargets }, ...sidebar };
        }).then(() => { if (seen) adopt(seen.tabs, seen.synced); });
      })
      .then(() => { if (lastSaveError) { lastSaveError = null; scheduleRender(); } },
        (error: unknown) => { lastSaveError = error instanceof Error ? error.message : String(error); scheduleRender(); });
  };

  /**
   * Takes what another writer stored: the projects it added, and the project
   * it made active when that changed since this cockpit's last read or write
   * (`synced`), which is then shown.
   */
  function adopt(stored: CockpitTabState, synced: string | null): void {
    if (closed) return;
    const merged = mergeProjects(tabs, stored);
    if (merged !== tabs) {
      tabs = merged;
      scheduleRender();
    }
    const requested = stored.activeProject;
    if (requested !== null && requested !== synced && requested !== tabs.activeProject) {
      if (apply((state) => showProject(state, requested)).ok) setFocus('slot');
    }
  }

  function reloadViewState(): void {
    if (closed) return;
    const stored = store.load();
    const synced = syncedActive;
    syncedActive = stored.tabs.activeProject;
    adopt(stored.tabs, synced);
  }

  const watched = new Map(options.projects.projects().map((state) => [state.project.id, state]));
  const projectInfo = (projectId: string): ProjectInfo => {
    const state = watched.get(projectId);
    return { stateDir: state?.project.state_dir ?? null, running: state?.connection === 'running', status: state?.status ?? null };
  };

  /** Keeps each running project's master target from its status view, so the master can be found while the coordinator is down. */
  function rememberMasterTargets(): boolean {
    let changed = false;
    for (const [projectId, state] of watched) {
      const master = state.status?.master;
      if (state.connection !== 'running' || !master?.tmux_socket || !master.tmux_session) continue;
      const target = { socket: master.tmux_socket, session: master.tmux_session };
      if (sameTarget(masterTargets[projectId], target)) continue;
      masterTargets[projectId] = target;
      changed = true;
    }
    return changed;
  }

  const targetOf = (tab: OpenTab): TmuxTarget | null => tab.agentId === null
    ? masterTarget(projectInfo(tab.projectId), masterTargets[tab.projectId] ?? null)
    : agentTarget(projectInfo(tab.projectId), tab.agentId);

  // ── sessions ──
  const sessions = new Sessions({ connect, scrollback: options.scrollback, resyncDelayMs: options.resyncDelayMs, onChange: () => { closeEndedExplorer(); scheduleRender(); } });
  const slotSize = () => ({ cols: layout.slot.cols, rows: layout.slot.rows });

  /** The session showActive last showed: its key and target. */
  let lastShown: { key: string | null; target: TmuxTarget | null } | null = null;

  /**
   * Shows the active tab's session (the others hidden and paused); none when it has no tmux target.
   * Only when the shown session changes are the selection and pending mouse motion dropped
   * (a watcher update shows the same one), and a tab that was left returns to view mode.
   */
  function showActive(): void {
    if (closed) return;
    const tab = shownTab(tabs);
    const key = shownKey();
    const target = explorer ? explorer.target : tab ? targetOf(tab) : null;
    if (!lastShown || lastShown.key !== key || !sameTarget(lastShown.target, target)) {
      motion.cancel();
      clearSelection();
    }
    if (lastShown?.key && lastShown.key !== key) typingTabs.delete(lastShown.key);
    lastShown = { key, target };
    if (explorer) {
      if (explorer.target) sessions.show(EXPLORER_KEY, explorer.target, true, slotSize());
      else sessions.hideAll();
      scheduleRender();
      return;
    }
    if (!tab || !target) sessions.hideAll();
    else sessions.show(tabKey(tab), target, true, slotSize());
    scheduleRender();
  }

  const stopWatching = options.projects.onUpdate((update) => {
    if (closed || update.type === 'event') return;
    if (update.type === 'registry_error') {
      registryError = update.error.message;
      scheduleRender();
      return;
    }
    if (update.type === 'removed' || update.type === 'added') registryError = null;
    if (update.type === 'removed') watched.delete(update.project_id);
    else if (update.type === 'added') watched.set(update.project_id, update.state);
    else {
      const state = watched.get(update.project_id);
      if (!state) return;
      if (update.type === 'status') watched.set(update.project_id, { ...state, status: update.status });
      else watched.set(update.project_id, { ...state, connection: update.connection, error: update.error });
      // A project that came back up: an ended master session of its shown tab is tried again.
      const tab = shownTab(tabs);
      if (update.type === 'connection' && update.connection === 'running' && tab?.projectId === update.project_id
        && sessions.get(tabKey(tab))?.state.kind === 'ended') sessions.close(tabKey(tab));
    }
    if (rememberMasterTargets()) save();
    showActive();
  });

  // ── widgets ──
  /** The sidebar's cards as drawn now: the active project, the other registered projects, the active one's agents; an agent that left is no longer expanded. */
  function currentSidebar() {
    const model = buildSidebarModel(buildProjectViews([...watched.values()]), {
      stateDir: '', activeProjectId: tabs.activeProject, nowMs: Date.now(), registryError, agentDetails: true,
    });
    nav = pruneExpanded(nav, model);
    return sidebarCardsLayout(model, layout.sidebar.rows, nav, layout.sidebar.cols);
  }

  /** The tab bar as drawn now: the active project's tabs, agent tabs marked with their mode and badged when they need a human. */
  function currentTabBar() {
    const project = tabs.activeProject;
    const model = buildTabBarModel(tabs, tabAttention(buildProjectViews([...watched.values()]), project));
    const marked = withModeMarks(model, (agentId) => project !== null && typingTabs.has(tabKey({ projectId: project, agentId })));
    return tabBarView(explorer ? withExplorerTab(marked) : marked, layout.tabBar.cols);
  }

  /** The header as drawn now: the active project's name and the explorer entry (neither with no project open) and the count of agents needing attention across projects. */
  function currentHeader() {
    const project = tabs.activeProject;
    const waiting = attentionQueue(tabs, [...watched.values()]).length;
    const buttons: HeaderButton[] = [
      ...(project === null || explorer || !options.explorer ? [] : [{ action: 'explorer' as const, text: EXPLORER_LABEL }]),
      ...(waiting > 0 ? [{ action: 'attention' as const, text: `! ${waiting}` }] : []),
    ];
    return headerView(layout.header.cols, project === null ? null : projectName(project), buttons);
  }

  /** The project's name as the watcher has it, else its id. */
  function projectName(projectId: string): string {
    return watched.get(projectId)?.project.name ?? projectId;
  }

  /** The footer's `project › tab`: the active project's name and the shown tab's label (the explorer's while it is shown). */
  function breadcrumb(): { project: string; tab: string } | null {
    const project = tabs.activeProject;
    if (project === null) return null;
    const active = buildTabBarModel(tabs).tabs.find((tab) => tab.active);
    return { project: projectName(project), tab: explorer ? EXPLORER_LABEL : active?.label ?? '' };
  }

  /** The keys' context: the shown tab's mode, and whether the sidebar has the keys. */
  function keyContext(): DispatchContext {
    const tab = shownTab(tabs);
    // With no tab shown nothing takes keys; cockpit keys still work.
    const context: DispatchContext = explorer
      ? { mode: 'view', agentTab: false, explorer: explorerMessage(explorer, sessions.shown(), keys) ? 'message' : 'live' }
      : tab ? inputContext(tab) : { mode: 'view', agentTab: false };
    return focus === 'slot' ? context : { ...context, sidebar: true };
  }

  /** What the slot shows: a message, or the shown tab's screen. */
  function slotContent(): { message: string[] | null; screen: Screen | null } {
    const session = sessions.shown();
    if (explorer) {
      const message = explorerMessage(explorer, session, keys);
      return { message, screen: message ? null : session?.screen ?? null };
    }
    const tab = shownTab(tabs);
    const project = tab && watched.get(tab.projectId);
    const message = slotMessage({
      tab, keys, session, target: tab ? targetOf(tab) : null,
      project: project ? { name: project.project.name, repoRoot: project.project.target_repo_root, connection: project.connection } : null,
    });
    return { message, screen: message ? null : session?.screen ?? null };
  }

  /**
   * The shown tab's header on the pane's top border: an agent's task, phase,
   * provider and run time with its attention badge; the master's coordinator,
   * worker capacity and task counts; the explorer's project.
   */
  function paneHeader(): PaneHeader | null {
    const tab = shownTab(tabs);
    const state = tab ? watched.get(tab.projectId) : undefined;
    const [view] = state ? buildProjectViews([state]) : [];
    if (explorer) return { title: 'tasks', parts: ['task explorer', view?.name ?? ''], badge: null };
    if (!tab || !view) return null;
    if (tab.agentId === null || tab.agentId === MASTER_TAB) {
      const status = view.status;
      const capacity = status?.worker_capacity;
      const counts = status?.tasks?.counts ?? {};
      const tasks = ['todo', 'in_progress', 'blocked'].filter((key) => counts[key]).map((key) => `${counts[key]} ${key.replace('_', ' ')}`);
      const state = projectState(view.connection);
      return {
        title: 'master',
        parts: [view.name, capacity ? `workers ${capacity.used_slots}/${capacity.configured_slots}` : '', tasks.length ? `tasks ${tasks.join(', ')}` : 'no open tasks'],
        badge: { label: `coordinator ${state}`, role: projectStateRole(state) },
      };
    }
    const model = buildSidebarModel([view], { stateDir: '', activeProjectId: view.project_id, nowMs: Date.now(), registryError: null, agentDetails: true });
    const agent = model.agents.find((candidate) => candidate.agent_id === tab.agentId);
    if (!agent) return { title: String(tab.agentId), parts: ['not running'], badge: null };
    return {
      title: agent.agent_id,
      parts: [agent.task_ref ?? agent.role, agent.phase, agent.provider ?? '', agent.elapsed ?? ''],
      badge: agent.attention ? { label: ATTENTION_BADGE[agent.attention], role: attentionRole(agent.attention) } : null,
    };
  }

  /**
   * The theme's background on every cell outside the slot that is left at
   * the terminal's default: where the terminal took the theme's colours (OSC
   * 11) this changes nothing visible; where it did not, the cockpit's own
   * areas still show the theme. The slot keeps its program's cells.
   */
  const canvas = theme.terminal ? parseThemeColor(theme.terminal.background) : null;
  function paintCanvas(frame: Frame): void {
    if (!canvas) return;
    const { slot } = layout;
    for (let y = 0; y < frame.rows; y += 1) {
      const inSlotRow = y >= slot.y && y < slot.y + slot.rows;
      for (let x = 0; x < frame.cols; x += 1) {
        if (inSlotRow && x >= slot.x && x < slot.x + slot.cols) continue;
        const cell = frame.cells[y * frame.cols + x];
        if (cell.style.bg.type === 'default') cell.style = { ...cell.style, bg: canvas };
      }
    }
  }

  // ── rendering ──
  function render(): void {
    renderTimer = null;
    if (closed) return;
    lastRender = Date.now();
    const frame = createFrame(layout.cols, layout.rows);
    drawHeader(frame, layout.header, currentHeader(), theme);
    drawSidebarCards(frame, layout.sidebar, currentSidebar(), { focus: focus === 'slot' ? null : focus, theme });
    drawTabBar(frame, layout.tabBar, currentTabBar(), {
      slotFocused: focus === 'slot',
      error: refusal ?? (lastSaveError ? `view state not saved: ${lastSaveError}` : null),
      theme,
    });
    if (layout.paneFrame) drawPaneBox(frame, layout.paneFrame, paneHeader(), focus === 'slot', theme);
    drawFooter(frame, layout.footer, { mode: modeNotice(keyContext()), breadcrumb: breadcrumb(), hints: footerHints(keys), theme });
    const { message, screen } = slotContent();
    let cursor: Cursor = { x: 0, y: 0, visible: false };
    if (!screen) {
      drawMessage(frame, layout.slot, message ?? [], theme);
    } else {
      blitScreen(frame, screen, layout.slot, { theme });
      if (selection?.moved && selection.key === shownKey()) highlightSelection(frame, layout.slot, screen, selection);
      cursor = slotCursor(screen, layout.slot, focus === 'slot');
    }
    // The dragged divider's preview, last so the pane's screen does not cover it.
    if (dividerDrag) {
      const line = styleOf(theme, 'chrome.borderFocus');
      for (let y = layout.gutter.y; y < layout.gutter.y + layout.gutter.rows; y += 1) drawText(frame, dividerDrag.x, y, '┃', line, 1);
    }
    // Arrow keys reach the pane in the form its program asked for; checked on every render, so on tab switch and mode change.
    mirrorCursorKeys(screen ? screen.modes().applicationCursorKeys : false);
    paintCanvas(frame);
    if (prevFrame && prevCursor && framesEqual(prevFrame, frame) && sameCursor(prevCursor, cursor)) return;
    terminal.write(renderDiff(prevFrame, frame, cursor, options.colorDepth));
    prevFrame = frame;
    prevCursor = cursor;
  }

  /** Renders soon: bursts of changes within one frame interval become one frame. */
  function scheduleRender(): void {
    if (closed || renderTimer) return;
    renderTimer = setTimeout(render, Math.max(0, lastRender + frameMs - Date.now()));
  }

  // ── tabs ──
  function apply(transition: (state: CockpitTabState) => TabTransition): TabTransition {
    const result = transition(tabs);
    if (closed) return result;
    if (!result.ok) {
      refusal = result.message;
      scheduleRender();
      return result;
    }
    refusal = null;
    // Any tab change leaves the task explorer for the tab it asked for.
    stopExplorer();
    // Closing a tab only detaches its view; the agent keeps running.
    for (const tab of closedTabs(tabs, result.state)) {
      sessions.close(tabKey(tab));
      typingTabs.delete(tabKey(tab)); // a reopened tab starts view-only again
    }
    tabs = result.state;
    save();
    showActive();
    return result;
  }

  // ── task explorer ──
  let explorer: ExplorerState | null = null;

  /** The shown session's key: the explorer's, the active tab's, or null. */
  const shownKey = (): string | null => {
    if (explorer) return EXPLORER_KEY;
    const tab = shownTab(tabs);
    return tab ? tabKey(tab) : null;
  };

  /** Shows the task explorer of the active project, starting its session; it takes the keys. Already shown: nothing changes. */
  function openExplorer(): void {
    if (explorer) return;
    const projectId = tabs.activeProject;
    if (!projectId || !options.explorer) {
      refusal = projectId ? 'This cockpit has no task explorer.' : 'No project is open in the cockpit; run orc start-session in one.';
      scheduleRender();
      return;
    }
    const host = options.explorer;
    const opened: ExplorerState = { projectId, target: null, error: null };
    explorer = opened;
    setFocus('slot');
    showActive();
    track(host.start(projectId, slotSize()).then(async (target) => {
      // Closed (or the cockpit quit) while it started: its session goes too.
      if (explorer !== opened || closed) { await host.stop(target); return; }
      opened.target = target;
      showActive();
    }, (error: unknown) => {
      opened.error = error instanceof Error ? error.message : String(error);
      scheduleRender();
    }));
  }

  /** Explorer starts and stops under way; quitting waits for them, so no explorer session outlives the cockpit. */
  let explorerWork: Promise<void> = Promise.resolve();
  function track(work: Promise<void>): void {
    explorerWork = Promise.all([explorerWork, work]).then(() => undefined);
  }

  /** Keys queued for the explorer: each is sent once the one before it reached the pane, then a short gap. */
  let explorerKeys: Promise<void> = Promise.resolve();
  const explorerKeyGapMs = options.explorerKeyGapMs ?? 4;
  function sendToExplorer(bytes: Buffer): void {
    const shownExplorer = explorer;
    explorerKeys = explorerKeys.then(async () => {
      // A key typed before the explorer closed never reaches the tab shown after it.
      if (closed || explorer !== shownExplorer) return;
      await sessions.get(EXPLORER_KEY)?.sendBytes(bytes)?.catch(ignoreInputError);
      await new Promise((resolve) => setTimeout(resolve, explorerKeyGapMs));
    });
  }

  /** Ends the task explorer: its view detaches and its session is killed. The caller shows the next tab. */
  function stopExplorer(): void {
    if (!explorer) return;
    const { target } = explorer;
    explorer = null;
    sessions.close(EXPLORER_KEY);
    if (target && options.explorer) track(options.explorer.stop(target));
  }

  function closeExplorer(): void {
    if (!explorer) return;
    stopExplorer();
    showActive();
  }

  /** An explorer that quit on its own (a failing one keeps its session to show why) closes, showing the active tab again. */
  function closeEndedExplorer(): void {
    if (explorer?.target && sessions.get(EXPLORER_KEY)?.state.kind === 'ended') queueMicrotask(closeExplorer);
  }

  /** Shows the next agent needing attention across projects (`nextAttention`); it takes the keys. */
  function jumpToAttention(): void {
    const waiting = attentionQueue(tabs, [...watched.values()]);
    if (waiting.length === 0) {
      refusal = 'No agent needs attention.';
      scheduleRender();
      return;
    }
    if (apply((state) => nextAttention(state, waiting)).ok) setFocus('slot');
  }

  // ── input ──
  const dispatcher = createDispatcher(keys);
  /** Agent tabs in typing mode, by tab key; every other agent tab is view-only. */
  const typingTabs = new Set<string>();
  const mirrorCursorKeys = cursorKeyMirror((data) => terminal.write(data));
  /** A plain left-button press: what selects a row or a tab (motion, releases, wheel and modified clicks do nothing here). */
  const isClick = (event: MouseEvent) => event.button === 'left' && !event.motion && !event.release && !event.shift && !event.alt && !event.ctrl;

  function setFocus(next: Focus): void {
    if (focus === next) return;
    focus = next;
    scheduleRender();
  }

  /** Runs what a sidebar key or click asks for; what it opens is shown and takes the keys, by key as by click. */
  function runSidebar(step: SidebarStep): void {
    nav = step.nav;
    scheduleRender();
    const command: SidebarCommand | null = step.command;
    if (!command) return;
    if (command.type === 'focusSlot') setFocus('slot');
    else if (command.type === 'openProject') { if (apply((state) => showProject(state, command.projectId)).ok) setFocus('slot'); }
    else if (apply((state) => openAgent(state, command.projectId, command.agentId)).ok) setFocus('slot');
  }

  /** Sidebar and tab bar clicks give the slot the keys, and so does a press in it; slot events go to onSlotMouse (mouse.ts routeSlotMouse). */
  const mouseHandlers: MouseHandlers = {
    gutter: (event) => onDividerMouse(event),
    header: (event, at) => {
      if (!isClick(event)) return;
      const button = headerButtonAt(currentHeader(), at.x);
      if (button === 'explorer') openExplorer();
      else if (button === 'attention') jumpToAttention();
    },
    sidebar: (event, at) => {
      if (!isClick(event)) return;
      const step = sidebarCardClick(currentSidebar(), nav, at.x, at.y);
      if (!step) return;
      runSidebar(step);
      // What was clicked is shown and takes the keys, as after a tab click (and a refused open too); the sidebar cursor stays on its row.
      // A click on a collapse marker only expands or collapses: a focused sidebar's keys follow the cursor to the agents box.
      if (step.command) setFocus('slot');
      else if (focus !== 'slot') setFocus(step.nav.box);
    },
    tabBar: (event, at) => {
      if (!isClick(event)) return;
      // Only the tabs' rows: their label row and its caps, not the gap row above the pane.
      if (Math.abs(at.y - Math.floor((layout.tabBar.rows - 1) / 2)) > 1) return;
      const view = currentTabBar();
      const click = tabBarClickTarget(view.model, view.layout, at.x);
      if (!click) return;
      if (click.tab.agentId === EXPLORER_TAB) {
        if (click.kind === 'close') closeExplorer();
        else setFocus('slot');
        return;
      }
      const id = click.tab.agentId ?? MASTER_TAB;
      // Closing only detaches the view; the agent keeps running.
      if (click.kind === 'close') apply((state) => closeTab(state, id));
      else {
        setFocus('slot');
        apply((state) => selectTab(state, id));
      }
    },
    slot: (event) => onSlotMouse(event),
  };

  /** Forwarded mouse reports, motion at most once per frame; they follow the shown tab. */
  const motion = createMotionCoalescer((bytes) => { sessions.shown()?.sendBytes(bytes)?.catch(ignoreInputError); }, frameMs);
  /** A press in the slot holds the mouse there until its release: a drag that leaves the slot still reaches the pane or the selection. */
  let slotGrab = false;
  /** The cockpit's selection in the shown tab (`key`); `moved` once the drag left its first cell, `dragging` until the release. */
  let selection: (Selection & { key: string; moved: boolean; dragging: boolean }) | null = null;

  function clearSelection(): void {
    if (!selection) return;
    selection = null;
    scheduleRender();
  }

  function onSlotMouse(event: MouseEvent): void {
    const press = !event.motion && !event.release && !event.button.startsWith('wheel');
    if (press) setFocus('slot');
    const tab = shownTab(tabs);
    const key = shownKey();
    const { screen } = slotContent();
    if (!key || !screen) return;
    const modes = screen.modes();
    const route = routeSlotMouse(event, {
      tracking: modes.mouseTracking,
      // The explorer takes keys, not the mouse: the cockpit scrolls and selects there.
      viewOnly: explorer !== null || (tab !== null && tab.agentId !== null && !typingTabs.has(tabKey(tab))),
      selecting: selection?.dragging ?? false,
    });
    // The pane as drawn: a worker's screen smaller than the slot is padded, a larger one cropped.
    const pane: Region = { x: layout.slot.x, y: layout.slot.y, cols: Math.min(layout.slot.cols, screen.cols), rows: Math.min(layout.slot.rows, screen.rows) };
    const at: CellPoint = {
      x: Math.min(Math.max(event.x - pane.x, 0), Math.max(pane.cols - 1, 0)),
      y: Math.min(Math.max(event.y - pane.y, 0), Math.max(pane.rows - 1, 0)),
    };
    if (press) slotGrab = route === 'forward' || route === 'selectStart';
    switch (route) {
      case 'forward':
        // The app's coordinates are live ones.
        if (screen.scrollOffset > 0) { screen.scrollToBottom(); scheduleRender(); }
        motion.push(encodeMouse(event, modes.mouseEncoding, pane, modes.mouseTracking), event.motion);
        return;
      case 'scrollUp': case 'scrollDown':
        clearSelection();
        screen.scroll(route === 'scrollUp' ? -WHEEL_LINES : WHEEL_LINES);
        scheduleRender();
        return;
      case 'selectStart':
        selection = { key, anchor: at, head: at, moved: false, dragging: true };
        scheduleRender();
        return;
      case 'selectExtend': case 'selectEnd': {
        if (!selection) return;
        const moved = selection.moved || at.x !== selection.anchor.x || at.y !== selection.anchor.y;
        selection = { ...selection, head: at, moved, dragging: route === 'selectExtend' };
        if (route === 'selectEnd') {
          // A click without a drag selects nothing.
          const text = moved ? selectionText(screen, selection) : '';
          if (text) terminal.write(osc52(text));
          else selection = null;
        }
        scheduleRender();
        return;
      }
      case 'drop': return;
    }
  }

  /** The shown tab's input mode: the master always types, an agent tab only after `i`. */
  function inputContext(tab: OpenTab): DispatchContext {
    if (tab.agentId === null) return { mode: 'typing', agentTab: false };
    return { mode: typingTabs.has(tabKey(tab)) ? 'typing' : 'view', agentTab: true };
  }

  /**
   * A failed keystroke or paste leaves the tab shown and the next input
   * flows: a session that ended is reported by the client's exit event.
   * Input to a tab that is not live is dropped.
   */
  const ignoreInputError = () => { /* see above */ };

  function onToken(token: Token): void {
    if (closed) return;
    const tab = shownTab(tabs);
    if (refusal && token.kind !== 'mouse') {
      refusal = null;
      scheduleRender();
    }
    if (token.kind !== 'mouse' && token.kind !== 'incomplete') {
      // Any key or paste returns a scrolled pane to live and ends the selection.
      const screen = sessions.shown()?.screen;
      if (screen && screen.scrollOffset > 0) { screen.scrollToBottom(); scheduleRender(); }
      clearSelection();
    }
    const action = dispatcher.dispatch(token, keyContext());
    switch (action.type) {
      case 'forward':
        if (explorer) sendToExplorer(action.bytes);
        else sessions.shown()?.sendBytes(action.bytes)?.catch(ignoreInputError);
        return;
      // A paste is UTF-8 text from the terminal; a byte that is not UTF-8 arrives as U+FFFD (cockpit2 runs the real terminal as UTF-8).
      case 'paste': sessions.shown()?.paste(action.data.toString('utf8'))?.catch(ignoreInputError); return;
      case 'mouse': {
        const event = parseSgrMouse(action.token);
        if (!event) return;
        const press = !event.motion && !event.release;
        if (dividerDrag) { onDividerMouse(event); return; }
        // A grab whose release never came ends at the next press, which goes where it is.
        if ((slotGrab || selection?.dragging) && !press) {
          onSlotMouse(event);
          if (event.release) slotGrab = false;
          return;
        }
        slotGrab = false;
        dispatchMouse(layout, event, mouseHandlers);
        return;
      }
      case 'quit': quit('quit'); return;
      case 'selectTab':
        // The explorer's own number shows it, as it already is.
        if (explorer && action.index === (tabs.projects.find((project) => project.projectId === tabs.activeProject)?.tabs.length ?? 0) + 2) return;
        apply((state) => selectTab(state, action.index));
        return;
      case 'cycleTab': apply((state) => cycleTab(state, action.delta)); return;
      case 'cycleProject': apply((state) => cycleProject(state, action.delta)); return;
      // Closes the explorer while it is shown; refused on the master tab, which stays open.
      case 'closeTab':
        if (explorer) closeExplorer();
        else apply((state) => closeTab(state));
        return;
      case 'startTyping':
      case 'stopTyping':
        if (!tab) return;
        if (action.type === 'startTyping') typingTabs.add(tabKey(tab));
        else typingTabs.delete(tabKey(tab));
        scheduleRender();
        return;
      case 'switchFocus': setFocus(focus === 'slot' ? nav.box : 'slot'); return;
      case 'focusSidebar': setFocus(nav.box); return;
      case 'sidebar': {
        // Only a focused sidebar gets these: the box the keys are in follows the cursor.
        const step = navigateSidebar(currentSidebar(), nav, action.key);
        setFocus(step.nav.box);
        runSidebar(step);
        return;
      }
      case 'explorer': openExplorer(); return;
      case 'attention': jumpToAttention(); return;
      case 'drop': return;
    }
  }

  const tokenizer = createTokenizer({ onFlush: (tokens) => tokens.forEach(onToken) });
  const stopInput = terminal.onInput((chunk) => tokenizer.push(chunk).forEach(onToken));
  // Run times in the sidebar change by the minute; a render with nothing changed writes nothing.
  const ticker = setInterval(scheduleRender, options.tickMs ?? 30_000);
  ticker.unref?.();
  /** Lays the terminal out again (its size or the sidebar's width changed): the shown window follows the slot. */
  function relayout(): void {
    const { cols, rows } = terminal.size();
    layout = computeLayout(cols, rows, sidebarWidth);
    clearSelection();
    sessions.resize(slotSize());
    scheduleRender();
  }
  const stopResize = terminal.onResize(relayout);

  /** The sidebar's width for the divider dragged to column `x`: kept in its range and leaving the slot its minimum. */
  const clampSidebar = (x: number) => Math.max(MIN_SIDEBAR_COLS, Math.min(MAX_SIDEBAR_COLS, x));

  /**
   * The divider: a press on the gutter grabs it, motion moves a preview line,
   * the release applies the width (the shown window is resized once, not on
   * every motion) and saves it; a double press resets the default width.
   */
  function onDividerMouse(event: MouseEvent): void {
    if (event.button !== 'left' && !event.release) return;
    if (!dividerDrag) {
      if (event.motion || event.release) return;
      const now = Date.now();
      if (now - lastGutterPress < DOUBLE_CLICK_MS) {
        lastGutterPress = 0;
        if (sidebarWidth !== SIDEBAR_COLS) { sidebarWidth = SIDEBAR_COLS; relayout(); save(); }
        return;
      }
      lastGutterPress = now;
      dividerDrag = { x: layout.sidebar.cols, pressX: event.x, startX: layout.sidebar.cols };
      scheduleRender();
      return;
    }
    // Relative to the press, so a click without motion keeps the width.
    const moved = event.x - dividerDrag.pressX;
    dividerDrag = { ...dividerDrag, x: moved === 0 ? dividerDrag.startX : clampSidebar(dividerDrag.startX + moved) };
    if (event.release) {
      const width = dividerDrag.x;
      dividerDrag = null;
      if (width !== layout.sidebar.cols) { sidebarWidth = width; relayout(); save(); }
      else scheduleRender();
      return;
    }
    scheduleRender();
  }

  function quit(reason: AppExit = 'quit'): void {
    if (closed) return;
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    clearInterval(ticker);
    motion.cancel();
    tokenizer.flush();
    stopInput();
    stopResize();
    stopWatching();
    // The explorer exists only while shown; closing the control clients detaches them, every other session keeps running.
    stopExplorer();
    sessions.closeAll();
    terminal.restore();
    void Promise.all([saving, explorerWork]).then(() => resolveDone(reason));
  }

  rememberMasterTargets();
  save();
  showActive();
  return { done, quit, apply, reloadViewState, tabs: () => tabs, saveError: () => lastSaveError };
}
