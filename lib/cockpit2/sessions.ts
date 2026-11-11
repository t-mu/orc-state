/**
 * lib/cockpit2/sessions.ts — one tmux control client and screen per open tab.
 *
 * A `PaneSession` attaches to one agent's tmux session and keeps a screen
 * model (screen.ts) of its pane. Most panes are attached after their program
 * started, so a shown session first runs the late-attach restore (mode query,
 * capture with the pane's history up to the screen's scrollback, restore, seed
 * modes) and then applies live `%output`.
 *
 * Sizing: the master tab owns its window (`owned`), which is sized to the
 * slot. Worker and scout views attach with `ignore-size` and never change the
 * agent's window; their screen keeps the pane's size and the app crops or pads
 * it into the slot.
 *
 * Hidden tabs: a hidden session pauses its pane's output (`refresh-client -A
 * '%pane:pause'`), so it cannot buffer without limit. tmux does not replay
 * output from the paused time, so showing it again continues the pane and runs
 * the late-attach restore before new output is applied.
 *
 * Closing a session only detaches its control client; the agent keeps running.
 */
import type { TmuxControlClient } from './tmuxControl.ts';
import { createScreen, type Screen } from './screen.ts';
import type { TmuxTarget } from './viewState.ts';

/** The part of a tmux control client a session uses; tests pass a fake. */
export type PaneClient = Pick<TmuxControlClient, 'on' | 'resize' | 'paneModes' | 'capture' | 'sendBytes' | 'paste' | 'pause' | 'resume' | 'close'>;

/** Opens a control client on `target`; `ignoreSize` for views that must not resize the window. */
export type ConnectPane = (target: TmuxTarget, options: { ignoreSize: boolean }) => PaneClient;

export interface SlotSize { cols: number; rows: number }

/**
 * - `attaching`: no screen restored yet.
 * - `live`: the screen shows the pane.
 * - `ended`: the session or its control client is gone (`reason` from tmux).
 */
export type PaneState = { kind: 'attaching' } | { kind: 'live' } | { kind: 'ended'; reason: string };

export interface PaneSessionOptions {
  target: TmuxTarget;
  /** The tab owns its window and sizes it to the slot (the master); otherwise an ignore-size view. */
  owned: boolean;
  connect: ConnectPane;
  /** The slot's size: an owned window follows it. */
  size: SlotSize;
  /** Scrollback lines kept for the screen (default 1000). */
  scrollback?: number | undefined;
  /** How long a layout change waits before the screen is captured again (default 50 ms). */
  resyncDelayMs?: number | undefined;
  /** Something visible changed: the screen, the state, or a failure to report. */
  onChange: () => void;
}

const sizeOf = (size: SlotSize) => ({ cols: Math.max(1, size.cols), rows: Math.max(1, size.rows) });
const ignore = () => { /* reported through the exit event or the next restore */ };

export class PaneSession {
  readonly target: TmuxTarget;
  readonly owned: boolean;
  private readonly client: PaneClient;
  private readonly options: PaneSessionOptions;
  private screenModel: Screen | null = null;
  private paneId: string | null = null;
  private current: PaneState = { kind: 'attaching' };
  /** The last restore failure; cleared by a restore that succeeds. */
  private failure: string | null = null;
  private visible = false;
  private closed = false;
  private size: SlotSize;

  // Pane output goes through `chain`, so writes, restores and resizes apply in arrival order.
  private chain: Promise<void> = Promise.resolve();
  /**
   * Output while the screen is captured: `drop` before the capture's reply
   * (the capture already shows it) and while hidden, `hold` after the capture
   * until the restore is applied, `live` otherwise.
   */
  private outputMode: 'drop' | 'hold' | 'live' = 'drop';
  private held: Buffer[] = [];
  private unwritten: Buffer[] = [];
  private syncing = false;
  private syncAgain = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PaneSessionOptions) {
    this.options = options;
    this.target = options.target;
    this.owned = options.owned;
    this.size = options.size;
    this.client = options.connect(options.target, { ignoreSize: !options.owned });
    this.client.on('output', (pane, bytes) => this.onOutput(pane, bytes));
    this.client.on('resize', () => this.requestSync());
    this.client.on('exit', (reason) => {
      if (this.closed) return;
      this.current = { kind: 'ended', reason };
      this.options.onChange();
    });
  }

  get state(): PaneState { return this.current; }
  /** Why the last restore failed while the session still runs; null when it is fine. */
  get error(): string | null { return this.failure; }
  /** The pane's screen, once restored. */
  get screen(): Screen | null { return this.screenModel; }
  get shown(): boolean { return this.visible; }

  /** Shows the tab: continues its pane's output (when paused), sizes an owned window, then restores the screen. */
  show(size: SlotSize = this.size): void {
    if (this.closed || this.visible) return;
    this.visible = true;
    this.size = size;
    if (this.paneId) this.client.resume(this.paneId).catch(ignore);
    if (this.owned) this.client.resize(sizeOf(size).cols, sizeOf(size).rows).catch(ignore);
    this.sync().catch((error: unknown) => this.fail(error));
  }

  /** Hides the tab: its pane's output is paused and dropped until it is shown again. */
  hide(): void {
    if (this.closed || !this.visible) return;
    this.visible = false;
    this.outputMode = 'drop';
    this.held = [];
    if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; }
    if (this.paneId) this.client.pause(this.paneId).catch(ignore);
  }

  /** The slot changed size: an owned window follows it; a view keeps the pane's size. */
  resize(size: SlotSize): void {
    this.size = size;
    if (this.owned && this.visible && !this.closed) this.client.resize(sizeOf(size).cols, sizeOf(size).rows).catch((error: unknown) => this.fail(error));
  }

  /** Input reaches the pane only while its screen is shown: live, and no restore failure on display. */
  private get typeable(): boolean {
    return this.current.kind === 'live' && this.paneId !== null && this.failure === null;
  }

  /** Types bytes into the pane; null (nothing sent) when it is not typeable. */
  sendBytes(bytes: Buffer): Promise<void> | null {
    if (!this.typeable || !this.paneId) return null;
    return this.client.sendBytes(this.paneId, bytes);
  }

  /** Pastes text into the pane; null (nothing sent) when it is not typeable. */
  paste(text: string): Promise<void> | null {
    if (!this.typeable || !this.paneId) return null;
    return this.client.paste(this.paneId, text);
  }

  /** Detaches the control client; the agent's session keeps running. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.client.close();
    this.screenModel?.dispose();
    this.screenModel = null;
  }

  private fail(error: unknown): void {
    // After %exit every pending command fails too; the exit state says why.
    if (this.closed || this.current.kind === 'ended') return;
    this.failure = error instanceof Error ? error.message : String(error);
    this.options.onChange();
  }

  /** Runs `op` after everything queued; its promise rejects when `op` fails, the chain goes on. */
  private enqueue(op: () => Promise<void> | void): Promise<void> {
    const run = this.chain.then(op);
    this.chain = run.catch(ignore);
    return run;
  }

  private onOutput(pane: string, bytes: Buffer): void {
    if (this.closed || pane !== this.paneId || this.outputMode === 'drop') return;
    if (this.outputMode === 'hold') this.held.push(bytes);
    else this.writeLive(bytes);
  }

  /** Live output not yet handed to the screen: a burst becomes one write, not one queued write per `%output`. */
  private writeLive(bytes: Buffer): void {
    this.unwritten.push(bytes);
    if (this.unwritten.length > 1) return; // a write of the batch is already queued
    void this.enqueue(() => {
      const batch = Buffer.concat(this.unwritten);
      this.unwritten = [];
      return this.screenModel?.write(batch);
    }).then(() => this.options.onChange(), (error: unknown) => this.fail(error));
  }

  /** Captures the screen again shortly: after a layout change tmux has reflowed the pane, which its output does not replay. */
  private requestSync(): void {
    if (this.closed || !this.visible) return;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.sync().catch((error: unknown) => this.fail(error));
    }, this.options.resyncDelayMs ?? 50);
  }

  /**
   * Late-attach restore: the pane's modes, its capture (with the main screen
   * kept under an alternate one), restore, seed modes, then the output that
   * arrived after the capture, then live output. A hidden session stops at
   * the mode query (to learn its pane and pause it); showing it runs this again.
   */
  private async sync(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    try {
      do {
        this.syncAgain = false;
        if (this.closed || !this.visible) return;
        this.outputMode = 'drop';
        this.held = [];
        this.unwritten = [];
        const modes = await this.client.paneModes(`=${this.target.session}:`);
        const firstSight = this.paneId === null;
        this.paneId = modes.paneId;
        if (!this.visible) {
          if (firstSight) await this.client.pause(modes.paneId);
          return;
        }
        const scrollback = this.options.scrollback ?? 1000;
        const main = modes.alternateOn ? await this.client.capture(modes.paneId, { saved: true }) : undefined;
        // The pane's history too, so the wheel reaches output from before the attach. An
        // alternate screen has no scrollback, and tmux keeps none under it.
        const lines = modes.alternateOn || scrollback <= 0
          ? await this.client.capture(modes.paneId)
          : await this.client.capture(modes.paneId, { history: scrollback });
        // Output emitted before this point is in the capture. (Output that came in the same read
        // as the capture's reply is emitted before this continuation runs, so it is dropped too;
        // the program's next redraw covers that narrow window.)
        if (this.closed || !this.visible) return;
        this.outputMode = 'hold';
        await this.enqueue(async () => {
          if (this.closed) return;
          if (!this.screenModel) this.screenModel = createScreen({ cols: modes.cols, rows: modes.rows, scrollback });
          else if (this.screenModel.cols !== modes.cols || this.screenModel.rows !== modes.rows) this.screenModel.resize(modes.cols, modes.rows);
          await this.screenModel.restore(main ? { lines, main } : { lines }, { x: modes.cursorX, y: modes.cursorY });
          await this.screenModel.seedModes(modes);
        });
        if (this.closed || !this.visible) return;
        for (const bytes of this.held.splice(0)) this.writeLive(bytes);
        this.outputMode = 'live';
        this.failure = null;
        if (this.current.kind === 'attaching') this.current = { kind: 'live' };
        this.options.onChange();
      } while (this.syncAgain && !this.closed);
    } finally {
      this.syncing = false;
    }
  }
}

export interface SessionsOptions {
  connect: ConnectPane;
  scrollback?: number | undefined;
  resyncDelayMs?: number | undefined;
  onChange: () => void;
}

/**
 * The open tabs' sessions by tab key. At most one is shown; the others are
 * hidden with their output paused. A session is created when its tab is first
 * shown, and replaced when its target changed or it ended (a retry).
 */
export class Sessions {
  private readonly sessions = new Map<string, PaneSession>();
  private shownKey: string | null = null;

  constructor(private readonly options: SessionsOptions) {}

  get(key: string): PaneSession | null { return this.sessions.get(key) ?? null; }
  keys(): string[] { return [...this.sessions.keys()]; }
  /** The shown tab's session, or null. */
  shown(): PaneSession | null { return this.shownKey === null ? null : this.get(this.shownKey); }

  /** Shows the tab `key` at `target`, hiding the one shown before. */
  show(key: string, target: TmuxTarget, owned: boolean, size: SlotSize): PaneSession {
    let session = this.sessions.get(key);
    const moved = session && (session.target.socket !== target.socket || session.target.session !== target.session || session.owned !== owned);
    // An ended session is retried when its tab is shown again; while it stays shown its message stays put.
    const retry = session?.state.kind === 'ended' && this.shownKey !== key;
    if (moved || retry) { this.close(key); session = undefined; }
    if (this.shownKey !== null && this.shownKey !== key) this.get(this.shownKey)?.hide();
    if (!session) {
      session = new PaneSession({ target, owned, size, connect: this.options.connect, scrollback: this.options.scrollback,
        resyncDelayMs: this.options.resyncDelayMs, onChange: this.options.onChange });
      this.sessions.set(key, session);
    }
    this.shownKey = key;
    session.show(size);
    return session;
  }

  /** Hides the shown tab (none is shown afterwards). */
  hideAll(): void {
    if (this.shownKey !== null) this.get(this.shownKey)?.hide();
    this.shownKey = null;
  }

  /** The slot changed size. */
  resize(size: SlotSize): void {
    for (const session of this.sessions.values()) session.resize(size);
  }

  /** Closes a tab's session: only the control client detaches. */
  close(key: string): void {
    this.sessions.get(key)?.close();
    this.sessions.delete(key);
    if (this.shownKey === key) this.shownKey = null;
  }

  closeAll(): void {
    for (const key of this.keys()) this.close(key);
  }
}
