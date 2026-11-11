/**
 * lib/cockpit2/app.ts — the cockpit2 app (Plan 6 Steps 6 and 7).
 *
 * Draws the whole terminal: a sidebar (left, fixed width), a tab bar (top
 * right, fixed height) and the slot, which shows the active tab: a project's
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
 * interval; an idle cockpit writes nothing. Keys typed go to the shown tab as
 * bytes, pastes through `paste()`. The quit key (`C-q` by default) or the
 * prefix then `d` ends the app; masters, workers and coordinators keep
 * running, and closing a tab only detaches its view. Sidebar and tab bar are
 * placeholders that Step 9 replaces; the prefix table comes with Step 8, mouse
 * routing with Step 10.
 */
import { tmuxSessionTarget, type ProjectConnectionState, type ProjectWatchState, type ProjectWatchUpdate, type StatusView } from '../../client.ts';
import { MASTER_TAB, closedTabs, shownTab, showProject, type CockpitTabState, type OpenTab, type TabTransition } from '../cockpitTabs.ts';
import { keyLabel, type CockpitKeys } from '../cockpitKeys.ts';
import { DEFAULT_STYLE, blitScreen, createFrame, drawText, slotCursor, type Frame, type Region } from './frame.ts';
import { createTokenizer, keyMatcher, type Token } from './input.ts';
import { parseSgrMouse, type MouseEvent } from './mouse.ts';
import { renderDiff, sameStyle } from './render.ts';
import type { Cursor } from './screen.ts';
import { Sessions, type ConnectPane, type PaneSession } from './sessions.ts';
import type { TerminalSession } from './terminal.ts';
import { TmuxControlClient } from './tmuxControl.ts';
import type { TmuxTarget, ViewState, ViewStateStore } from './viewState.ts';

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

// ── the app ───────────────────────────────────────────────────────────────────

/** The part of a `ProjectWatcher` the app reads; the CLI layer starts and stops it. */
export type ProjectSource = { projects(): ProjectWatchState[]; onUpdate(listener: (update: ProjectWatchUpdate) => void): () => void };

export interface AppOptions {
  terminal: TerminalSession;
  /** The tmux binary, resolved by the CLI layer. */
  tmuxBinary: string;
  /** The cockpit lock under orc's data home, from the CLI layer (the single-instance lock comes with Step 12). */
  lockPath: string;
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
}

export interface App {
  /** Resolves once the app has quit, the terminal is restored and the view state saved. */
  readonly done: Promise<void>;
  /** Why the last view-state save failed; null once one succeeds. The CLI reports it after the terminal is restored. */
  saveError(): string | null;
  quit(): void;
  /** Applies a tab transition (lib/cockpitTabs.ts); Step 8 binds keys to these. A refused one changes nothing. */
  apply(transition: (state: CockpitTabState) => TabTransition): TabTransition;
  /** The current tabs and projects. */
  tabs(): CockpitTabState;
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

/** The placeholder sidebar: the cockpit's projects, the active one marked (Step 9 draws the real one). */
function drawSidebar(frame: Frame, region: Region, tabs: CockpitTabState, nameOf: (projectId: string) => string): void {
  const active = tabs.activeProject;
  drawBox(frame, region, active ? nameOf(active) : 'orc');
  tabs.projects.forEach((project, index) => {
    if (index + 2 >= region.rows || region.cols < 6) return;
    const isActive = project.projectId === active;
    drawText(frame, region.x + 2, region.y + 1 + index, `${isActive ? '›' : ' '} ${nameOf(project.projectId)}`,
      isActive ? TITLE_STYLE : MUTED_STYLE, region.cols - 4);
  });
}

/** The placeholder tab bar: the active project's tabs, the active one bold, and how to quit (Step 9 draws the real one). */
function drawTabBar(frame: Frame, region: Region, tabs: CockpitTabState, keys: CockpitKeys, saveError: string | null): void {
  if (region.cols === 0 || region.rows === 0) return;
  const row = region.y + Math.min(1, region.rows - 1);
  const project = tabs.projects.find((entry) => entry.projectId === tabs.activeProject);
  let x = region.x + 1;
  for (const tab of project ? [null, ...project.tabs] : []) {
    const label = ` ${tab ?? MASTER_TAB} `;
    const room = region.x + region.cols - x;
    if (room <= 0) break;
    drawText(frame, x, row, label, tab === project?.active ? TITLE_STYLE : MUTED_STYLE, room);
    x += label.length + 1;
  }
  if (region.rows >= 3) drawText(frame, region.x, region.y + region.rows - 1, '─'.repeat(region.cols), MUTED_STYLE);
  const hint = saveError ? `view state not saved: ${saveError}` : quitHint(keys);
  const room = region.x + region.cols - x;
  if (room > 0) drawText(frame, Math.max(x, region.x + region.cols - hint.length - 1), row, hint, MUTED_STYLE, room);
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
const sameTarget = (a: TmuxTarget | undefined, b: TmuxTarget) => a?.socket === b.socket && a.session === b.session;

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
  const frameMs = options.frameMs ?? 16;
  const connect: ConnectPane = options.connect
    ?? ((target, { ignoreSize }) => new TmuxControlClient({ tmuxBinary: options.tmuxBinary, socket: target.socket, session: target.session, ignoreSize }));

  let layout = computeLayout(terminal.size().cols, terminal.size().rows);
  let prevFrame: Frame | null = null;
  let prevCursor: Cursor | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRender = 0;
  let closed = false;
  /** Only the slot exists to focus until Step 9 makes the sidebar focusable. */
  const focus: RegionName = 'slot';

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  // ── view state ──
  const loaded = store.load();
  let tabs = showProject(loaded.tabs, options.projectId).state;
  const masterTargets: ViewState['masterTargets'] = { ...loaded.masterTargets };
  let saving: Promise<void> = Promise.resolve();
  let lastSaveError: string | null = null;
  /**
   * Saves the view state after the saves before it, through the store's locked
   * read-change-write: this cockpit's tabs replace the stored ones (Step 12
   * merges projects added by another writer here), master targets are merged.
   * A failed save leaves the file as it was and is shown in the tab bar; the next save retries.
   */
  const save = () => {
    saving = saving
      .then(() => store.update((stored) => ({ tabs, masterTargets: { ...stored.masterTargets, ...masterTargets } })))
      .then(() => { if (lastSaveError) { lastSaveError = null; scheduleRender(); } },
        (error: unknown) => { lastSaveError = error instanceof Error ? error.message : String(error); scheduleRender(); });
  };

  const watched = new Map(options.projects.projects().map((state) => [state.project.id, state]));
  const projectInfo = (projectId: string): ProjectInfo => {
    const state = watched.get(projectId);
    return { stateDir: state?.project.state_dir ?? null, running: state?.connection === 'running', status: state?.status ?? null };
  };
  const nameOf = (projectId: string) => watched.get(projectId)?.project.name ?? projectId;

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
  const sessions = new Sessions({ connect, scrollback: options.scrollback, resyncDelayMs: options.resyncDelayMs, onChange: () => scheduleRender() });
  const slotSize = () => ({ cols: layout.slot.cols, rows: layout.slot.rows });

  /** Shows the active tab's session (the others hidden and paused); none when it has no tmux target. */
  function showActive(): void {
    if (closed) return;
    const tab = shownTab(tabs);
    const target = tab ? targetOf(tab) : null;
    if (!tab || !target) sessions.hideAll();
    else sessions.show(tabKey(tab), target, tab.agentId === null, slotSize());
    scheduleRender();
  }

  const stopWatching = options.projects.onUpdate((update) => {
    if (closed || update.type === 'event' || update.type === 'registry_error') return;
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

  // ── rendering ──
  function render(): void {
    renderTimer = null;
    if (closed) return;
    lastRender = Date.now();
    const frame = createFrame(layout.cols, layout.rows);
    drawSidebar(frame, layout.sidebar, tabs, nameOf);
    drawTabBar(frame, layout.tabBar, tabs, keys, lastSaveError);
    const tab = shownTab(tabs);
    const session = sessions.shown();
    const project = tab && watched.get(tab.projectId);
    const message = slotMessage({
      tab, keys, session, target: tab ? targetOf(tab) : null,
      project: project ? { name: project.project.name, repoRoot: project.project.target_repo_root, connection: project.connection } : null,
    });
    let cursor: Cursor = { x: 0, y: 0, visible: false };
    if (message || !session?.screen) {
      drawMessage(frame, layout.slot, message ?? []);
    } else {
      blitScreen(frame, session.screen, layout.slot);
      cursor = slotCursor(session.screen, layout.slot, focus === 'slot');
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

  // ── tabs ──
  function apply(transition: (state: CockpitTabState) => TabTransition): TabTransition {
    const result = transition(tabs);
    if (closed || !result.ok) return result;
    // Closing a tab only detaches its view; the agent keeps running.
    for (const tab of closedTabs(tabs, result.state)) sessions.close(tabKey(tab));
    tabs = result.state;
    save();
    showActive();
    return result;
  }

  // ── input ──
  const matchQuit = keyMatcher(keys.quit ? [keys.quit] : []);
  const matchPrefix = keyMatcher([keys.prefix]);
  const matchDetach = keyMatcher(['d']);
  let prefixPending = false;
  /** Steps 9 and 10 fill these in: sidebar and tab bar clicks, pane mouse routing. */
  const mouseHandlers: MouseHandlers = {};

  /**
   * A failed keystroke or paste leaves the tab shown and the next input
   * flows: a session that ended is reported by the client's exit event.
   * Input to a tab that is not live is dropped.
   */
  const ignoreInputError = () => { /* see above */ };
  const forward = (bytes: Buffer) => { sessions.shown()?.sendBytes(bytes)?.catch(ignoreInputError); };

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
      sessions.shown()?.paste(token.data.toString('utf8'))?.catch(ignoreInputError);
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
    sessions.resize(slotSize());
    scheduleRender();
  });

  function quit(): void {
    if (closed) return;
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    tokenizer.flush();
    stopInput();
    stopResize();
    stopWatching();
    // Closing the control clients detaches them; every session keeps running.
    sessions.closeAll();
    terminal.restore();
    void saving.then(resolveDone);
  }

  rememberMasterTargets();
  save();
  showActive();
  return { done, quit, apply, tabs: () => tabs, saveError: () => lastSaveError };
}
