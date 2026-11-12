/**
 * lib/cockpit2/dispatch.ts — input tokens (input.ts) → cockpit actions (Plan 6 Step 8).
 *
 * Pure apart from the prefix state it keeps between tokens. Order of decisions:
 *
 * 1. `incomplete` tokens are dropped: a sequence cut short is never typed into a pane.
 * 2. Mouse reports go to the mouse router; pastes go to the pane (dropped in
 *    view mode and while the sidebar has the focus).
 * 3. Cockpit keys, in every mode: the quit key, the direct keys (F1-F11 by
 *    default) and the prefix. After the prefix: `d` quits, `o` switches focus,
 *    `n`/`p` cycle tabs, `&` closes the active tab, `1`-`9` select a tab,
 *    `N`/`P` cycle projects, `t` opens the task explorer, and the prefix again
 *    reaches the pane (typing mode only). Any other key after the prefix is dropped.
 * 4. With the sidebar focused, the rest is sidebar navigation (arrows or
 *    j/k, Tab or Shift-Tab to cycle the cards, Enter, Space to expand or
 *    collapse an agent, Esc);
 *    no key or paste reaches a pane.
 * 5. On the task explorer tab while its screen is shown (`live`), Ctrl-] closes
 *    it and every other key reaches the explorer, which owns them: arrows or
 *    j/k, Enter, Esc/q/h/Backspace back from a task, Esc or q in its list to
 *    quit (its session ends and the cockpit closes the tab), s/f filters.
 *    While it shows a message instead (`message`: starting, or failed), the
 *    close keys of view mode close it and other keys are dropped. Pastes and
 *    the prefix twice are dropped there.
 * 6. Otherwise the tab's mode decides the rest. The master tab is always `typing`.
 *    Worker and scout tabs open in `view`: no key reaches the agent; `q`, Esc,
 *    Ctrl-D, Ctrl-C and Ctrl-] close the tab, `i` starts typing. In `typing`
 *    every key goes to the pane byte-exact, a lone Esc included, except Ctrl-]
 *    on an agent tab, which returns to view mode.
 *
 * None of the view and typing keys needs the prefix.
 *
 * Typing writes into the pane through tmux directly and takes no coordinator
 * terminal lease (Plan 6 leaves leases out, as for `orc attach --write`), so
 * an `orc terminal --write` holder can type into the same agent at once.
 */
import { COCKPIT_ACTIONS, type CockpitAction, type CockpitKeys } from '../cockpitKeys.ts';
import { keyMatcher, type Token } from './input.ts';

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
  /** Prefix then o: switch focus between sidebar and pane (Step 9). */
  | { type: 'switchFocus' }
  /** The direct dashboard key: focus the sidebar (Step 9). */
  | { type: 'focusSidebar' }
  /** The direct attention key: the next agent needing attention (Step 11). */
  | { type: 'attention' }
  /** Prefix then t: the task explorer tab (Step 11). */
  | { type: 'explorer' }
  | { type: 'startTyping' }
  | { type: 'stopTyping' }
  /** A sidebar navigation key while the sidebar has the focus. */
  | { type: 'sidebar'; key: SidebarKey }
  /** Nothing happens; `reason` for tests and debugging. */
  | { type: 'drop'; reason: 'incomplete' | 'view' | 'prefix' | 'sidebar' };

/** Sidebar navigation: move the cursor, cycle the projects, project and agents boxes (forward, back), open, expand or collapse an agent, back to the pane. */
export type SidebarKey = 'up' | 'down' | 'switchBox' | 'prevBox' | 'open' | 'toggle' | 'back';

export interface DispatchContext {
  /** The shown tab's mode; the master tab passes `typing`. */
  mode: InputMode;
  /** The shown tab is an agent (worker or scout) tab: Ctrl-] toggles its mode. False for the master. */
  agentTab: boolean;
  /** The sidebar has the focus: keys navigate it and nothing reaches the pane. */
  sidebar?: boolean;
  /** The task explorer is shown: `live` its screen, which takes every key but Ctrl-]; `message` why it has none. Pass mode `view` with it. */
  explorer?: 'live' | 'message';
}

/** Keys of agent tabs, the same as `orc terminal --view-first` (lib/terminalKeys.ts). */
export const VIEW_CLOSE_KEYS = ['q', 'Escape', 'C-d', 'C-c', 'C-]'];
export const START_TYPING_KEY = 'i';
export const STOP_TYPING_KEY = 'C-]';
/** Sidebar navigation keys by tmux key name. */
export const SIDEBAR_KEYS: Readonly<Record<string, SidebarKey>> = {
  Up: 'up', k: 'up', Down: 'down', j: 'down', Tab: 'switchBox', BTab: 'prevBox', Enter: 'open', Space: 'toggle', Escape: 'back',
};

/** The first key name bound to a sidebar key (`Enter` for open), for hints. */
export function sidebarKeyName(key: SidebarKey): string {
  return Object.keys(SIDEBAR_KEYS).find((name) => SIDEBAR_KEYS[name] === key) ?? key;
}

/**
 * One line naming the focus or the shown tab's mode and its keys: the
 * footer's first segment, kept short (the footer cuts it last).
 */
export function modeNotice(context: DispatchContext): string {
  if (context.sidebar) return 'Tab: card · Enter: open · Space: +/- · Esc: pane';
  if (context.explorer) return context.explorer === 'live' ? '[tasks] Ctrl-] or ×: close' : '[tasks] q/Esc: close';
  if (!context.agentTab) return '[master] keys go to the master';
  return context.mode === 'view'
    ? '[view] i: type · q/Esc: close'
    : '[typing] Ctrl-]: stop typing';
}

export interface Dispatcher {
  dispatch(token: Token, context: DispatchContext): DispatchAction;
  /** Whether the prefix was pressed and the next key goes to the prefix table. */
  readonly prefixPending: boolean;
}

const PREFIX_TABLE: Record<string, DispatchAction> = {
  d: { type: 'quit' },
  o: { type: 'switchFocus' },
  n: { type: 'cycleTab', delta: 1 },
  p: { type: 'cycleTab', delta: -1 },
  '&': { type: 'closeTab' },
  N: { type: 'cycleProject', delta: 1 },
  P: { type: 'cycleProject', delta: -1 },
  t: { type: 'explorer' },
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), { type: 'selectTab', index: index + 1 }])),
};

function directAction(action: CockpitAction): DispatchAction {
  if (action === 'dashboard') return { type: 'focusSidebar' };
  if (action === 'attention') return { type: 'attention' };
  return { type: 'selectTab', index: Number(action.slice(3)) };
}

export function createDispatcher(keys: CockpitKeys): Dispatcher {
  const matchQuit = keyMatcher(keys.quit ? [keys.quit] : []);
  const matchPrefix = keyMatcher([keys.prefix]);
  const matchPrefixTable = keyMatcher(Object.keys(PREFIX_TABLE));
  const directKeys = COCKPIT_ACTIONS.flatMap((action) => (keys.direct[action] ? [[keys.direct[action], action] as const] : []));
  const directByKey = new Map<string, CockpitAction>(directKeys);
  const matchDirect = keyMatcher(directKeys.map(([key]) => key));
  const matchClose = keyMatcher(VIEW_CLOSE_KEYS);
  const matchStart = keyMatcher([START_TYPING_KEY]);
  const matchStop = keyMatcher([STOP_TYPING_KEY]);
  const matchSidebar = keyMatcher(Object.keys(SIDEBAR_KEYS));
  let prefixPending = false;

  function dispatch(token: Token, context: DispatchContext): DispatchAction {
    if (token.kind === 'incomplete') return { type: 'drop', reason: 'incomplete' };
    if (token.kind === 'mouse') return { type: 'mouse', token };
    if (prefixPending) {
      prefixPending = false;
      if (token.kind !== 'paste') {
        // The prefix twice reaches the pane, as tmux's send-prefix does; only a tab in typing mode takes it.
        if (matchPrefix(token)) {
          if (context.sidebar) return { type: 'drop', reason: 'sidebar' };
          return context.mode === 'typing' ? { type: 'forward', bytes: token.raw } : { type: 'drop', reason: 'view' };
        }
        const name = matchPrefixTable(token);
        return name ? PREFIX_TABLE[name] : { type: 'drop', reason: 'prefix' };
      }
    }
    if (token.kind === 'paste') {
      if (context.sidebar) return { type: 'drop', reason: 'sidebar' };
      return context.mode === 'typing' ? { type: 'paste', data: token.data } : { type: 'drop', reason: 'view' };
    }
    if (matchQuit(token)) return { type: 'quit' };
    if (matchPrefix(token)) { prefixPending = true; return { type: 'drop', reason: 'prefix' }; }
    const direct = matchDirect(token);
    if (direct) return directAction(directByKey.get(direct)!);
    if (context.sidebar) {
      const key = matchSidebar(token);
      return key ? { type: 'sidebar', key: SIDEBAR_KEYS[key] } : { type: 'drop', reason: 'sidebar' };
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

  return { dispatch, get prefixPending() { return prefixPending; } };
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
