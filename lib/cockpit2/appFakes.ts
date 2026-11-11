import type { ProjectWatchState, ProjectWatchUpdate } from '../../client.ts';
import { createScreen, type Screen } from './screen.ts';
import type { TerminalSession } from './terminal.ts';
import { DEFAULT_VIEW_STATE, type TmuxTarget, type ViewState, type ViewStateStore } from './viewState.ts';
import { SIDEBAR_COLS, computeLayout, type App } from './app.ts';

// Fakes and wait helpers shared by app.test.ts and app.integration.test.ts.
export const ESC = '\x1b';
export const F12 = `${ESC}[24~`;
export async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class FakeTerminal implements TerminalSession {
  cols = 80;
  rows = 24;
  writes: string[] = [];
  restored = 0;
  private input = new Set<(chunk: Buffer) => void>();
  private resizes = new Set<() => void>();
  size() { return { cols: this.cols, rows: this.rows }; }
  write(data: string) { this.writes.push(data); }
  onInput(listener: (chunk: Buffer) => void) { this.input.add(listener); return () => this.input.delete(listener); }
  onResize(listener: () => void) { this.resizes.add(listener); return () => this.resizes.delete(listener); }
  restore() { this.restored++; }
  type(text: string) { for (const listener of this.input) listener(Buffer.from(text, 'latin1')); }
  resizeTo(cols: number, rows: number) { this.cols = cols; this.rows = rows; for (const listener of this.resizes) listener(); }
}

export class FakeWatcher {
  private listeners = new Set<(update: ProjectWatchUpdate) => void>();
  constructor(public states: ProjectWatchState[]) {}
  projects() { return this.states; }
  onUpdate(listener: (update: ProjectWatchUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(update: ProjectWatchUpdate) { for (const listener of this.listeners) listener(update); }
}

export class MemoryStore implements ViewStateStore {
  /** Set to make the next updates fail. */
  failWith: Error | null = null;
  constructor(public state: ViewState = DEFAULT_VIEW_STATE) {}
  load() { return this.state; }
  update(change: (stored: ViewState) => ViewState) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.state = structuredClone(change(this.state));
    return Promise.resolve(this.state);
  }
}

export const MASTER_TARGET = { socket: 'orc-sock', session: 'orc-master' };
export const W1_TARGET = { socket: 'orc-sock', session: 'orc-w1' };

export type FakeWorker = { agent_id: string; attention?: { kind: 'question' | 'permission_prompt' | 'stalled' | 'no_progress'; detail: string | null } } & TmuxTarget;

export function projectState(id: string, options: { running?: boolean; master?: TmuxTarget | null; workers?: FakeWorker[]; name?: string } = {}): ProjectWatchState {
  const { running = true, master = MASTER_TARGET, workers = [] } = options;
  return {
    project: { id, name: options.name ?? `${id}-project`, target_repo_root: `/repo/${id}`, state_dir: `/state/${id}`, repo_present: true, control_socket: null, coordinator_running: running },
    connection: running ? 'running' : 'stopped',
    error: null,
    status: {
      master: { agent_id: 'master', tmux_socket: master?.socket ?? null, tmux_session: master?.session ?? null },
      worker_capacity: {
        configured_slots: 2, used_slots: workers.length,
        slots: workers.map((worker) => ({
          ...worker, role: 'worker', status: 'running', slot_state: 'busy', attention: worker.attention ?? null,
          tmux_socket: worker.socket, tmux_session: worker.session, session_handle: `tmux:${worker.socket}:${worker.session}`,
        })),
      },
      claims: { active: [] },
      scouts: [],
    } as never,
    cursor: null,
  };
}

/** The real terminal as a user would see it: every write replayed into an emulator. */
export async function shown(terminal: FakeTerminal): Promise<Screen> {
  const screen = createScreen({ cols: terminal.cols, rows: terminal.rows, scrollback: 0 });
  await screen.write(terminal.writes.join(''));
  return screen;
}
export const text = (screen: Screen, y: number, x = 0, cols = screen.cols) =>
  screen.row(y).slice(x, x + cols).map((cell) => cell.text).join('').trimEnd();
/** The slot's rows as the real terminal shows them. */
export async function slotRows(terminal: FakeTerminal): Promise<string[]> {
  const screen = await shown(terminal);
  const { slot } = computeLayout(terminal.cols, terminal.rows);
  return Array.from({ length: slot.rows }, (_, y) => text(screen, slot.y + y, slot.x, slot.cols));
}
/** Waits until a slot row is `line` on the real terminal (the renderer writes only changed cells, so the bytes alone do not say). */
export async function waitForSlotLine(terminal: FakeTerminal, line: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await slotRows(terminal)).includes(line)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(line)} in the slot:\n${(await slotRows(terminal)).join("\n")}`);
    await sleep(25);
  }
}

/** Waits until row `y` of the tab bar contains `part`. */
export async function waitForTabBar(terminal: FakeTerminal, y: number, part: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (!text(await shown(terminal), y, SIDEBAR_COLS).includes(part)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(part)} in tab bar row ${y}: ${text(await shown(terminal), y, SIDEBAR_COLS)}`);
    await sleep(25);
  }
}

/** The sidebar's rows as the real terminal shows them. */
export async function sidebarRows(terminal: FakeTerminal): Promise<string[]> {
  const screen = await shown(terminal);
  return Array.from({ length: terminal.rows }, (_, y) => text(screen, y, 0, SIDEBAR_COLS));
}

/** Waits until some sidebar row contains `part`. */
export async function waitForSidebar(terminal: FakeTerminal, part: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (!(await sidebarRows(terminal)).some((row) => row.includes(part))) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(part)} in the sidebar:\n${(await sidebarRows(terminal)).join('\n')}`);
    await sleep(25);
  }
}

/** Waits until some slot row contains `part` (messages are drawn indented). */
export async function waitForSlotText(terminal: FakeTerminal, part: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (!(await slotRows(terminal)).some((row) => row.includes(part))) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(part)} in the slot:\n${(await slotRows(terminal)).join('\n')}`);
    await sleep(25);
  }
}

export const apps: App[] = [];
