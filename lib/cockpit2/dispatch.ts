/**
 * lib/cockpit2/dispatch.ts — input tokens (input.ts) → cockpit actions (Plan 6 Step 8).
 *
 * Pure apart from the leader state it keeps between tokens and its timer. Order of decisions:
 *
 * 1. `incomplete` tokens are dropped: a sequence cut short is never typed into a pane.
 * 2. Mouse reports go to the mouse router; pastes go to the pane (dropped in
 *    view mode and while the sidebar or the tab strip has the focus).
 * 3. Cockpit keys, in every mode: the quit key (none by default), the direct
 *    keys (F1-F11 by default) and the leader (Ctrl-Space by default). After
 *    the leader the next key is a command of `LEADER_TABLE`; `←`/`→`/`h`/`l`,
 *    `Tab` and `Shift-Tab` keep the leader armed, so they repeat, and any other
 *    command, `Esc`, an unbound key (dropped) or `LEADER_TIMEOUT_MS` without
 *    a key disarm it. The leader again reaches the pane (typing mode only).
 * 4. With the sidebar focused, the rest is sidebar navigation (arrows or
 *    j/k, Tab or Shift-Tab to cycle the cards, Enter, Space to expand or
 *    collapse an agent, x to kill it (the app asks first), Esc);
 *    no key or paste reaches a pane. With the tab strip focused, `←`/`→` move
 *    its highlight, `Enter` shows the highlighted tab, `w`/`Delete` close it,
 *    `Esc`/`↓` return to the pane; nothing else does anything.
 * 5. On the task explorer tab while its screen is shown (`live`), Ctrl-] closes
 *    it and every other key reaches the explorer, which owns them: arrows or
 *    j/k, Enter, Esc/q/h/Backspace back from a task, Esc or q in its list to
 *    quit (its session ends and the cockpit closes the tab), s/f filters.
 *    While it shows a message instead (`message`: starting, or failed), the
 *    close keys of view mode close it and other keys are dropped. Pastes and
 *    the leader twice are dropped there.
 * 6. Otherwise the tab's mode decides the rest. The master tab is always `typing`.
 *    Worker and scout tabs open in `view`: no key reaches the agent; `q`, Esc,
 *    Ctrl-D, Ctrl-C and Ctrl-] close the tab, `i` starts typing. In `typing`
 *    every key goes to the pane byte-exact, a lone Esc included, except Ctrl-]
 *    on an agent tab, which returns to view mode.
 *
 * None of the view and typing keys needs the leader.
 *
 * Typing writes into the pane through tmux directly and takes no coordinator
 * terminal lease (Plan 6 leaves leases out, as for `orc attach --write`), so
 * an `orc terminal --write` holder can type into the same agent at once.
 */
import { COCKPIT_ACTIONS, keyLabel, type CockpitAction, type CockpitKeys } from '../cockpitKeys.ts';
import { keyMatcher, type Token, type TokenizerTimers } from './input.ts';

/** A tab's input mode: `view` lets no key reach the agent; `typing` forwards keys. The master tab is always `typing`. */
export type InputMode = 'view' | 'typing';

export type DispatchAction =
  /** Bytes for the shown pane. */
  | { type: 'forward'; bytes: Buffer }
  /** A bracketed paste's content for the shown pane. */
  | { type: 'paste'; data: Buffer }
  | { type: 'mouse'; token: Extract<Token, { kind: 'mouse' }> }
  | { type: 'quit' }
  /** A tab of the active project by 1-based position (1 is the master tab). */
  | { type: 'selectTab'; index: number }
  | { type: 'cycleTab'; delta: 1 | -1 }
  | { type: 'cycleProject'; delta: 1 | -1 }
  /** Close the active agent tab (the tab shown next is the one `closeTab` picks), or the task explorer while it is shown. */
  | { type: 'closeTab' }
  /** The container focus ring, Pane → Tab strip → Sidebar → Pane (`delta` 1), or back. */
  | { type: 'cycleFocus'; delta: 1 | -1 }
  /** The dashboard key or the leader then s: the sidebar from the pane or the tab strip, the pane from the sidebar. */
  | { type: 'focusSidebar' }
  /** The leader then p: the pane takes the keys. */
  | { type: 'focusPane' }
  /** The direct attention key or the leader then !: the next agent needing attention (Step 11). */
  | { type: 'attention' }
  /** The leader then e: the task explorer tab (Step 11). */
  | { type: 'explorer' }
  /** The leader then t: a new shell tab, as the `+` tab. */
  | { type: 'newShell' }
  /** The leader then a: the new-agent dialog of the active project. */
  | { type: 'newAgent' }
  /** The leader then ,: the settings dialog of the active project. */
  | { type: 'settings' }
  /** The leader then ?: the help dialog. */
  | { type: 'help' }
  | { type: 'startTyping' }
  | { type: 'stopTyping' }
  /** The leader then i: start or stop typing on the shown worker or scout tab. */
  | { type: 'toggleTyping' }
  /** A sidebar navigation key while the sidebar has the focus. */
  | { type: 'sidebar'; key: SidebarKey }
  /** A tab strip key while the tab strip has the focus. */
  | { type: 'tabStrip'; key: TabStripKey }
  /** Nothing happens; `reason` for tests and debugging. */
  | { type: 'drop'; reason: 'incomplete' | 'view' | 'leader' | 'sidebar' | 'tabStrip' };

/** Sidebar navigation: move the cursor, cycle the projects, project and agents boxes (forward, back), open, expand or collapse an agent, kill an agent (asks first), back to the pane. */
export type SidebarKey = 'up' | 'down' | 'switchBox' | 'prevBox' | 'open' | 'toggle' | 'expand' | 'collapse' | 'kill' | 'back';

/** Tab strip keys: move the highlight, show the highlighted tab, close it, back to the pane. */
export type TabStripKey = 'left' | 'right' | 'open' | 'close' | 'back';

export interface DispatchContext {
  /** The shown tab's mode; the master tab passes `typing`. */
  mode: InputMode;
  /** The shown tab is an agent (worker or scout) tab: Ctrl-] toggles its mode. False for the master. */
  agentTab: boolean;
  /** The sidebar has the focus: keys navigate it and nothing reaches the pane. */
  sidebar?: boolean;
  /** The tab strip has the focus: keys move its highlight and nothing reaches the pane. */
  tabStrip?: boolean;
  /** The task explorer is shown: `live` its screen, which takes every key but Ctrl-]; `message` why it has none. Pass mode `view` with it. */
  explorer?: 'live' | 'message';
}

/** Keys of agent tabs, the same as `orc terminal --view-first` (lib/terminalKeys.ts). */
export const VIEW_CLOSE_KEYS = ['q', 'Escape', 'C-d', 'C-c', 'C-]'];
export const START_TYPING_KEY = 'i';
export const STOP_TYPING_KEY = 'C-]';
/** Sidebar navigation keys by tmux key name. */
export const SIDEBAR_KEYS: Readonly<Record<string, SidebarKey>> = {
  Up: 'up', k: 'up', Down: 'down', j: 'down', Tab: 'switchBox', BTab: 'prevBox', Enter: 'open', Space: 'toggle', x: 'kill', Escape: 'back',
  Right: 'expand', l: 'expand', Left: 'collapse', h: 'collapse',
};
/** Tab strip keys by tmux key name. */
export const TAB_STRIP_KEYS: Readonly<Record<string, TabStripKey>> = {
  Left: 'left', Right: 'right', Enter: 'open', w: 'close', Delete: 'close', Escape: 'back', Down: 'back',
};

/** The first key name bound to a sidebar key (`Enter` for open), for hints. */
export function sidebarKeyName(key: SidebarKey): string {
  return Object.keys(SIDEBAR_KEYS).find((name) => SIDEBAR_KEYS[name] === key) ?? key;
}

/** The leader's commands by tmux key name, with what each does for the help dialog. */
export const LEADER_TABLE: Readonly<Record<string, { action: DispatchAction; help: string }>> = {
  Left: { action: { type: 'cycleTab', delta: -1 }, help: 'previous tab (repeats)' },
  h: { action: { type: 'cycleTab', delta: -1 }, help: 'previous tab (repeats)' },
  Right: { action: { type: 'cycleTab', delta: 1 }, help: 'next tab (repeats)' },
  l: { action: { type: 'cycleTab', delta: 1 }, help: 'next tab (repeats)' },
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), { action: { type: 'selectTab', index: index + 1 }, help: `tab ${index + 1}` }])),
  Tab: { action: { type: 'cycleFocus', delta: 1 }, help: 'next container: pane → tab strip → sidebar (repeats)' },
  BTab: { action: { type: 'cycleFocus', delta: -1 }, help: 'previous container (repeats)' },
  s: { action: { type: 'focusSidebar' }, help: 'sidebar (from the sidebar: the pane)' },
  p: { action: { type: 'focusPane' }, help: 'pane' },
  w: { action: { type: 'closeTab' }, help: 'close the current tab' },
  t: { action: { type: 'newShell' }, help: 'new shell tab' },
  a: { action: { type: 'newAgent' }, help: 'new agent' },
  n: { action: { type: 'cycleProject', delta: 1 }, help: 'next project' },
  N: { action: { type: 'cycleProject', delta: -1 }, help: 'previous project' },
  e: { action: { type: 'explorer' }, help: 'task explorer' },
  ',': { action: { type: 'settings' }, help: 'project settings' },
  '!': { action: { type: 'attention' }, help: 'next agent needing attention' },
  i: { action: { type: 'toggleTyping' }, help: 'type into the worker or scout tab, or stop' },
  '?': { action: { type: 'help' }, help: 'this help' },
  q: { action: { type: 'quit' }, help: 'quit the cockpit' },
};
/** Leader commands after which the leader stays armed: tab and container walking repeats. */
const LEADER_REPEATS = new Set(['Left', 'h', 'Right', 'l', 'Tab', 'BTab']);
/** How long the armed leader waits for its command. */
export const LEADER_TIMEOUT_MS = 1000;

/** The footer's first segment while the leader is armed: its main keys. */
export const LEADER_NOTICE = 'LEADER ←→ tab · Tab focus · 1-9 · ? help';

/**
 * One line naming the focus or the shown tab's mode and its keys: the
 * footer's first segment, kept short (the footer cuts it last).
 */
export function modeNotice(context: DispatchContext): string {
  if (context.sidebar) return 'Tab: card · Enter: open/expand · Esc: pane';
  if (context.tabStrip) return '[tabs] ←→ · Enter: show · w: close · Esc: pane';
  if (context.explorer) return context.explorer === 'live' ? '[tasks] Ctrl-] or ×: close' : '[tasks] q/Esc: close';
  if (!context.agentTab) return '[master] keys go to the master';
  return context.mode === 'view'
    ? '[view] i: type · q/Esc: close'
    : '[typing] Ctrl-]: stop typing';
}

/** The leader then `key` as a hint reads it: `Ctrl-Space q`. */
export const leaderLabel = (keys: CockpitKeys, key: string): string => `${keyLabel(keys.prefix)} ${key}`;

export interface DispatcherOptions {
  /** Timers for the leader's timeout (default: setTimeout, unref'd). */
  timers?: TokenizerTimers;
  /** How long the armed leader waits (default LEADER_TIMEOUT_MS). */
  leaderTimeoutMs?: number;
  /** Called when the leader disarms on its timeout (the app redraws the footer). */
  onLeaderTimeout?: () => void;
}

export interface Dispatcher {
  dispatch(token: Token, context: DispatchContext): DispatchAction;
  /** Whether the leader is armed: the next key is a leader command. */
  readonly leaderArmed: boolean;
  /** Disarms the leader and cancels its timer (on quit). */
  disarm(): void;
}

function directAction(action: CockpitAction): DispatchAction {
  if (action === 'dashboard') return { type: 'focusSidebar' };
  if (action === 'attention') return { type: 'attention' };
  return { type: 'selectTab', index: Number(action.slice(3)) };
}

const defaultTimers: TokenizerTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createDispatcher(keys: CockpitKeys, options: DispatcherOptions = {}): Dispatcher {
  const timers = options.timers ?? defaultTimers;
  const timeoutMs = options.leaderTimeoutMs ?? LEADER_TIMEOUT_MS;
  const matchQuit = keyMatcher(keys.quit ? [keys.quit] : []);
  const matchLeader = keyMatcher([keys.prefix]);
  const matchLeaderTable = keyMatcher(Object.keys(LEADER_TABLE));
  const matchEscape = keyMatcher(['Escape']);
  const directKeys = COCKPIT_ACTIONS.flatMap((action) => (keys.direct[action] ? [[keys.direct[action], action] as const] : []));
  const directByKey = new Map<string, CockpitAction>(directKeys);
  const matchDirect = keyMatcher(directKeys.map(([key]) => key));
  const matchClose = keyMatcher(VIEW_CLOSE_KEYS);
  const matchStart = keyMatcher([START_TYPING_KEY]);
  const matchStop = keyMatcher([STOP_TYPING_KEY]);
  const matchSidebar = keyMatcher(Object.keys(SIDEBAR_KEYS));
  const matchTabStrip = keyMatcher(Object.keys(TAB_STRIP_KEYS));
  let armed = false;
  let timer: unknown = null;

  function disarm(): void {
    armed = false;
    if (timer != null) timers.clear(timer);
    timer = null;
  }

  function arm(): void {
    disarm();
    armed = true;
    timer = timers.set(() => {
      timer = null;
      armed = false;
      options.onLeaderTimeout?.();
    }, timeoutMs);
  }

  /** The key after the leader: a command, the leader again for the pane, Esc, or an unbound key (dropped). */
  function leaderCommand(token: Token, context: DispatchContext): DispatchAction {
    // The leader twice reaches the pane, as tmux's send-prefix does; only a tab in typing mode takes it.
    if (matchLeader(token)) {
      disarm();
      if (context.sidebar) return { type: 'drop', reason: 'sidebar' };
      if (context.tabStrip) return { type: 'drop', reason: 'tabStrip' };
      return context.mode === 'typing' ? { type: 'forward', bytes: token.raw } : { type: 'drop', reason: 'view' };
    }
    if (matchEscape(token)) { disarm(); return { type: 'drop', reason: 'leader' }; }
    const name = matchLeaderTable(token);
    if (!name) { disarm(); return { type: 'drop', reason: 'leader' }; }
    if (LEADER_REPEATS.has(name)) arm();
    else disarm();
    return LEADER_TABLE[name].action;
  }

  function dispatch(token: Token, context: DispatchContext): DispatchAction {
    if (token.kind === 'incomplete') return { type: 'drop', reason: 'incomplete' };
    if (token.kind === 'mouse') return { type: 'mouse', token };
    if (armed) {
      if (token.kind !== 'paste') return leaderCommand(token, context);
      disarm();
    }
    if (token.kind === 'paste') {
      if (context.sidebar) return { type: 'drop', reason: 'sidebar' };
      if (context.tabStrip) return { type: 'drop', reason: 'tabStrip' };
      return context.mode === 'typing' ? { type: 'paste', data: token.data } : { type: 'drop', reason: 'view' };
    }
    if (matchQuit(token)) return { type: 'quit' };
    if (matchLeader(token)) { arm(); return { type: 'drop', reason: 'leader' }; }
    const direct = matchDirect(token);
    if (direct) return directAction(directByKey.get(direct)!);
    if (context.sidebar) {
      const key = matchSidebar(token);
      return key ? { type: 'sidebar', key: SIDEBAR_KEYS[key] } : { type: 'drop', reason: 'sidebar' };
    }
    if (context.tabStrip) {
      const key = matchTabStrip(token);
      return key ? { type: 'tabStrip', key: TAB_STRIP_KEYS[key] } : { type: 'drop', reason: 'tabStrip' };
    }
    if (context.explorer === 'live') return matchStop(token) ? { type: 'closeTab' } : { type: 'forward', bytes: token.raw };
    if (context.explorer === 'message') return matchClose(token) ? { type: 'closeTab' } : { type: 'drop', reason: 'view' };
    if (context.mode === 'typing') {
      if (context.agentTab && matchStop(token)) return { type: 'stopTyping' };
      return { type: 'forward', bytes: token.raw };
    }
    if (matchClose(token)) return { type: 'closeTab' };
    if (matchStart(token)) return { type: 'startTyping' };
    return { type: 'drop', reason: 'view' };
  }

  return { dispatch, disarm, get leaderArmed() { return armed; } };
}

/** The real terminal's cursor key mode as a sequence: DECCKM set (`ESC [ ? 1 h`) or reset. */
export const cursorKeyModeSequence = (application: boolean) => (application ? '\x1b[?1h' : '\x1b[?1l');

/** Keeps the real terminal's cursor key mode equal to the shown pane's, writing only on a change. */
export function cursorKeyMirror(write: (data: string) => void): (application: boolean) => void {
  // The terminal starts in normal cursor key mode (terminal.ts resets it on restore).
  let current = false;
  return (application) => {
    if (application === current) return;
    current = application;
    write(cursorKeyModeSequence(application));
  };
}
