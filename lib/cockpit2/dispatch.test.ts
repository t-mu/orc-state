import { describe, expect, it } from 'vitest';
import { DEFAULT_COCKPIT_KEYS, type CockpitKeys } from '../cockpitKeys.ts';
import {
  LEADER_NOTICE, LEADER_TABLE, createDispatcher, cursorKeyMirror, modeNotice, sidebarKeyName, type DispatchAction, type DispatchContext,
} from './dispatch.ts';
import { createTokenizer, type Token, type TokenizerTimers } from './input.ts';

const ESC = '\x1b';
const F12 = `${ESC}[24~`;
/** Ctrl-Space, the default leader: a NUL byte. */
const LEADER = '\x00';
const MASTER: DispatchContext = { mode: 'typing', agentTab: false };
const VIEW: DispatchContext = { mode: 'view', agentTab: true };
const TYPING: DispatchContext = { mode: 'typing', agentTab: true };

/** Tokens of `input`, held bytes flushed (a lone Esc comes out at once). */
function tokens(input: string): Token[] {
  const tokenizer = createTokenizer({ timers: { set: () => null, clear: () => undefined } });
  return [...tokenizer.push(Buffer.from(input, 'latin1')), ...tokenizer.flush()];
}

function run(input: string, context: DispatchContext, keys: CockpitKeys = DEFAULT_COCKPIT_KEYS): DispatchAction[] {
  const dispatcher = createDispatcher(keys);
  return tokens(input).map((token) => dispatcher.dispatch(token, context));
}

const forwarded = (actions: DispatchAction[]) => actions.flatMap((action) => (action.type === 'forward' ? [action.bytes.toString('latin1')] : []));
const types = (actions: DispatchAction[]) => actions.map((action) => action.type);

/** Timers the test fires by hand. */
function fakeTimers(): TokenizerTimers & { fire(): void; pending(): number } {
  let next: (() => void) | null = null;
  return {
    set: (callback) => { next = callback; return callback; },
    clear: (handle) => { if (next === handle) next = null; },
    fire: () => { const callback = next; next = null; callback?.(); },
    pending: () => (next ? 1 : 0),
  };
}

describe('createDispatcher: cockpit keys and the leader', () => {
  it('forwards ordinary keys to the master byte-exact, a lone Esc included', () => {
    const actions = run(`ls\r${ESC}[A${ESC}OB${ESC}x\x7f`, MASTER);
    expect(forwarded(actions)).toEqual(['l', 's', '\r', `${ESC}[A`, `${ESC}OB`, `${ESC}x`, '\x7f']);
    expect(forwarded(run(ESC, MASTER))).toEqual([ESC]);
  });

  it('runs every leader command, each after its own leader', () => {
    const table = ['\x1b[D', 'h', '\x1b[C', 'l', ...'123456789', '\t', `${ESC}[Z`, ...'spwtanNe,!i?q'].map((key) => run(`${LEADER}${key}`, MASTER)[1]);
    expect(table).toEqual([
      { type: 'cycleTab', delta: -1 }, { type: 'cycleTab', delta: -1 }, { type: 'cycleTab', delta: 1 }, { type: 'cycleTab', delta: 1 },
      ...Array.from({ length: 9 }, (_, index) => ({ type: 'selectTab', index: index + 1 })),
      { type: 'cycleFocus', delta: 1 }, { type: 'cycleFocus', delta: -1 },
      { type: 'focusSidebar' }, { type: 'focusPane' }, { type: 'closeTab' }, { type: 'newShell' }, { type: 'newAgent' },
      { type: 'cycleProject', delta: 1 }, { type: 'cycleProject', delta: -1 }, { type: 'explorer' }, { type: 'settings' },
      { type: 'attention' }, { type: 'toggleTyping' }, { type: 'help' }, { type: 'quit' },
    ]);
    // The old prefix letters are not leader commands.
    for (const key of 'odP&') expect(run(`${LEADER}${key}`, MASTER)[1]).toEqual({ type: 'drop', reason: 'leader' });
    expect(Object.keys(LEADER_TABLE)).not.toContain('o');
  });

  it('stays armed after ←/→/h/l, Tab and Shift-Tab, so they repeat, and disarms after any other command', () => {
    const dispatcher = createDispatcher(DEFAULT_COCKPIT_KEYS, { timers: fakeTimers() });
    const actions = tokens(`${LEADER}\x1b[C\x1b[Clh\t${ESC}[Z\x1b[D3x`).map((token) => dispatcher.dispatch(token, MASTER));
    expect(actions.slice(1, 9)).toEqual([
      { type: 'cycleTab', delta: 1 }, { type: 'cycleTab', delta: 1 }, { type: 'cycleTab', delta: 1 }, { type: 'cycleTab', delta: -1 },
      { type: 'cycleFocus', delta: 1 }, { type: 'cycleFocus', delta: -1 }, { type: 'cycleTab', delta: -1 }, { type: 'selectTab', index: 3 },
    ]);
    expect(dispatcher.leaderArmed).toBe(false);
    expect(forwarded(actions)).toEqual(['x']); // disarmed after 3: x reaches the master
  });

  it('disarms on Esc and on an unbound key, both dropped and neither sent to the pane', () => {
    for (const key of [ESC, 'x', 'z', '\r']) {
      const dispatcher = createDispatcher(DEFAULT_COCKPIT_KEYS, { timers: fakeTimers() });
      const actions = tokens(`${LEADER}${key}`).map((token) => dispatcher.dispatch(token, MASTER));
      expect(actions).toEqual([{ type: 'drop', reason: 'leader' }, { type: 'drop', reason: 'leader' }]);
      expect(dispatcher.leaderArmed).toBe(false);
    }
  });

  it('disarms after its timeout with no key, telling the app; each repeat restarts the timer', () => {
    const timers = fakeTimers();
    let timeouts = 0;
    const dispatcher = createDispatcher(DEFAULT_COCKPIT_KEYS, { timers, onLeaderTimeout: () => { timeouts += 1; } });
    dispatcher.dispatch(tokens(LEADER)[0], MASTER);
    expect(dispatcher.leaderArmed).toBe(true);
    dispatcher.dispatch(tokens('l')[0], MASTER);
    expect([dispatcher.leaderArmed, timers.pending()]).toEqual([true, 1]);
    timers.fire();
    expect([dispatcher.leaderArmed, timeouts]).toEqual([false, 1]);
    expect(forwarded([dispatcher.dispatch(tokens('l')[0], MASTER)])).toEqual(['l']);
    // A command that disarms cancels the timer.
    dispatcher.dispatch(tokens(LEADER)[0], MASTER);
    dispatcher.dispatch(tokens('w')[0], MASTER);
    expect(timers.pending()).toBe(0);
  });

  it('sends the leader to the pane when pressed twice in typing mode (Ctrl-Space as NUL), drops it in view mode', () => {
    expect(forwarded(run(`${LEADER}${LEADER}`, MASTER))).toEqual([LEADER]);
    expect(forwarded(run(`${LEADER}${LEADER}`, TYPING))).toEqual([LEADER]);
    expect(run(`${LEADER}${LEADER}`, VIEW).at(-1)).toEqual({ type: 'drop', reason: 'view' });
    expect(forwarded(run(`${LEADER}${LEADER}l`, MASTER))).toEqual([LEADER, 'l']); // disarmed after it
  });

  it('takes the leader from the keys setting', () => {
    const keys = { ...DEFAULT_COCKPIT_KEYS, prefix: 'F12' };
    expect(forwarded(run(`${F12}${F12}`, MASTER, keys))).toEqual([F12]);
    expect(run(`${F12}n`, MASTER, keys).at(-1)).toEqual({ type: 'cycleProject', delta: 1 });
    expect(forwarded(run(LEADER, MASTER, keys))).toEqual([LEADER]); // Ctrl-Space is an ordinary key now
  });

  it('runs the direct keys in every mode; Ctrl-q is no quit key by default but one when bound', () => {
    for (const context of [MASTER, VIEW, TYPING]) {
      expect(run(`${ESC}OP${ESC}[20~${ESC}[21~${ESC}[23~`, context)).toEqual([
        { type: 'selectTab', index: 1 }, { type: 'selectTab', index: 9 }, { type: 'focusSidebar' }, { type: 'attention' },
      ]);
    }
    expect(forwarded(run('\x11', MASTER))).toEqual(['\x11']);
    for (const context of [MASTER, VIEW, TYPING]) expect(run('\x11', context, { ...DEFAULT_COCKPIT_KEYS, quit: 'C-q' })).toEqual([{ type: 'quit' }]);
  });

  it('leaves a direct key that is unbound to the pane', () => {
    const keys: CockpitKeys = { ...DEFAULT_COCKPIT_KEYS, direct: { ...DEFAULT_COCKPIT_KEYS.direct, tab1: null } };
    expect(forwarded(run(`${ESC}OP`, MASTER, keys))).toEqual([`${ESC}OP`]);
  });

  it('shows the leader\'s main keys in the footer notice', () => {
    expect(LEADER_NOTICE).toBe('LEADER ←→ tab · Tab focus · 1-9 · ? help');
  });

  it('drops incomplete sequences in every mode, the leader armed or not', () => {
    const incomplete: Token = { kind: 'incomplete', raw: Buffer.from(`${ESC}[1;`) };
    for (const context of [MASTER, VIEW, TYPING]) {
      const dispatcher = createDispatcher(DEFAULT_COCKPIT_KEYS, { timers: fakeTimers() });
      expect(dispatcher.dispatch(incomplete, context)).toEqual({ type: 'drop', reason: 'incomplete' });
      dispatcher.dispatch(tokens(LEADER)[0], context);
      expect(dispatcher.dispatch(incomplete, context)).toEqual({ type: 'drop', reason: 'incomplete' });
      expect(dispatcher.leaderArmed).toBe(true);
    }
    // A sequence the tokenizer cut short comes out as one incomplete token, never as text.
    expect(run(`${ESC}[1;`, MASTER)).toEqual([{ type: 'drop', reason: 'incomplete' }]);
  });

  it('hands mouse reports to the mouse router', () => {
    expect(types(run(`${ESC}[<0;5;5M`, VIEW))).toEqual(['mouse']);
  });
});

describe('createDispatcher: view and typing modes', () => {
  it('sends no key to a view-mode agent tab', () => {
    const actions = run(`hello\r${ESC}[Aabc\x01`, VIEW);
    expect(forwarded(actions)).toEqual([]);
    expect(actions.every((action) => action.type === 'drop')).toBe(true);
  });

  it('closes a view-mode agent tab on q, Esc, Ctrl-D, Ctrl-C and Ctrl-] in one keypress', () => {
    for (const key of ['q', ESC, '\x04', '\x03', '\x1d']) expect(run(key, VIEW)).toEqual([{ type: 'closeTab' }]);
    // Alt-q is not q, and Q is not q.
    expect(types(run(`${ESC}qQ`, VIEW))).toEqual(['drop', 'drop']);
  });

  it('starts typing on i and stops on Ctrl-]', () => {
    expect(run('i', VIEW)).toEqual([{ type: 'startTyping' }]);
    expect(run('\x1d', TYPING)).toEqual([{ type: 'stopTyping' }]);
  });

  it('forwards every other key byte-exact in typing mode, the view-mode keys and a lone Esc included', () => {
    expect(forwarded(run(`iq\x04\x03x${ESC}[1;5C`, TYPING))).toEqual(['i', 'q', '\x04', '\x03', 'x', `${ESC}[1;5C`]);
    expect(forwarded(run(ESC, TYPING))).toEqual([ESC]);
  });

  it('forwards Ctrl-] to the master, which has no view mode', () => {
    expect(forwarded(run('\x1d', MASTER))).toEqual(['\x1d']);
  });


  it('pastes in typing mode and drops a paste in view mode', () => {
    const paste = `${ESC}[200~one\ntwo${ESC}[201~`;
    for (const context of [MASTER, TYPING]) {
      const [action] = run(paste, context);
      expect(action.type === 'paste' && action.data.toString()).toBe('one\ntwo');
    }
    expect(run(paste, VIEW)).toEqual([{ type: 'drop', reason: 'view' }]);
  });

  it('a paste right after the leader disarms it and is pasted', () => {
    const dispatcher = createDispatcher(DEFAULT_COCKPIT_KEYS, { timers: fakeTimers() });
    const actions = tokens(`${LEADER}${ESC}[200~x${ESC}[201~q`).map((token) => dispatcher.dispatch(token, MASTER));
    expect(types(actions)).toEqual(['drop', 'paste', 'forward']);
  });

  it('names the focus or the mode and its keys, short enough to leave the 80-column footer room', () => {
    expect(modeNotice(VIEW)).toBe('[view] i: type · q/Esc: close');
    expect(modeNotice(TYPING)).toBe('[typing] Ctrl-]: stop typing');
    expect(modeNotice(MASTER)).toContain('master');
    expect(modeNotice({ ...VIEW, sidebar: true })).toBe('Tab: card · Enter: open/expand · Esc: pane');
    for (const context of [VIEW, TYPING, MASTER]) expect(modeNotice(context).length).toBeLessThanOrEqual(32);
    // The sidebar's keys are the most: still under 50 columns, which leaves an 80-column footer its breadcrumb.
    expect(modeNotice({ ...MASTER, sidebar: true }).length).toBeLessThanOrEqual(48);
    expect(modeNotice({ ...MASTER, tabStrip: true }).length).toBeLessThanOrEqual(48);
    expect(LEADER_NOTICE.length).toBeLessThanOrEqual(48);
  });
});

describe('createDispatcher: sidebar focus', () => {
  const SIDEBAR: DispatchContext = { ...TYPING, sidebar: true };

  it('turns arrows, j/k, Tab, Shift-Tab, Enter and Esc into sidebar navigation', () => {
    expect(run(`${ESC}[A${ESC}OBkj\t${ESC}[Z\r${ESC}`, SIDEBAR)).toEqual([
      { type: 'sidebar', key: 'up' }, { type: 'sidebar', key: 'down' }, { type: 'sidebar', key: 'up' }, { type: 'sidebar', key: 'down' },
      { type: 'sidebar', key: 'switchBox' }, { type: 'sidebar', key: 'prevBox' }, { type: 'sidebar', key: 'open' }, { type: 'sidebar', key: 'back' },
    ]);
  });

  it('turns Space into the toggle key, and only while the sidebar has the focus: in the slot it reaches the pane', () => {
    expect(run(' ', SIDEBAR)).toEqual([{ type: 'sidebar', key: 'toggle' }]);
    expect(forwarded(run(' ', TYPING))).toEqual([' ']);
    expect(forwarded(run(' ', MASTER))).toEqual([' ']);
    expect(run(' ', VIEW)).toEqual([{ type: 'drop', reason: 'view' }]);
    expect([sidebarKeyName('open'), sidebarKeyName('toggle')]).toEqual(['Enter', 'Space']);
  });

  it('turns → and l into expand, ← and h into collapse in the sidebar; in the slot the arrows reach the pane', () => {
    expect(run('\x1b[C', SIDEBAR)).toEqual([{ type: 'sidebar', key: 'expand' }]);
    expect(run('l', SIDEBAR)).toEqual([{ type: 'sidebar', key: 'expand' }]);
    expect(run('\x1b[D', SIDEBAR)).toEqual([{ type: 'sidebar', key: 'collapse' }]);
    expect(run('h', SIDEBAR)).toEqual([{ type: 'sidebar', key: 'collapse' }]);
    expect(forwarded(run('\x1b[C', TYPING))).toEqual(['\x1b[C']);
  });

  it('turns x into the kill key while the sidebar has the focus; elsewhere it reaches the pane or is dropped', () => {
    expect(run('x', SIDEBAR)).toEqual([{ type: 'sidebar', key: 'kill' }]);
    expect(sidebarKeyName('kill')).toBe('x');
    expect(forwarded(run('x', TYPING))).toEqual(['x']);
    expect(run('x', VIEW)).toEqual([{ type: 'drop', reason: 'view' }]);
  });

  it('lets no key, paste or doubled leader reach the pane, even from a typing tab', () => {
    const actions = run(`ziq\x1d${ESC}[200~p${ESC}[201~${LEADER}${LEADER}`, SIDEBAR);
    expect(actions.every((action) => action.type === 'drop')).toBe(true);
    expect(actions.at(-1)).toEqual({ type: 'drop', reason: 'sidebar' });
  });

  it('keeps the cockpit keys and the leader table', () => {
    expect(run(`${LEADER}q`, SIDEBAR).at(-1)).toEqual({ type: 'quit' });
    expect(run(`${LEADER}s`, SIDEBAR).at(-1)).toEqual({ type: 'focusSidebar' });
    expect(run(`${LEADER}\t`, SIDEBAR).at(-1)).toEqual({ type: 'cycleFocus', delta: 1 });
    expect(run(`${ESC}OP`, SIDEBAR)).toEqual([{ type: 'selectTab', index: 1 }]);
  });
});

describe('createDispatcher: tab strip focus', () => {
  const TABS: DispatchContext = { ...TYPING, tabStrip: true };

  it('turns ←/→, Enter, w, Delete, Esc and ↓ into tab strip keys', () => {
    expect(run(`${ESC}[D${ESC}[C\rw${ESC}[3~${ESC}[B`, TABS)).toEqual([
      { type: 'tabStrip', key: 'left' }, { type: 'tabStrip', key: 'right' }, { type: 'tabStrip', key: 'open' },
      { type: 'tabStrip', key: 'close' }, { type: 'tabStrip', key: 'close' }, { type: 'tabStrip', key: 'back' },
    ]);
    expect(run(ESC, TABS)).toEqual([{ type: 'tabStrip', key: 'back' }]);
    expect(modeNotice(TABS)).toBe('[tabs] ←→ · Enter: show · w: close · Esc: pane');
  });

  it('lets no other key, paste or doubled leader reach the pane', () => {
    const actions = run(`ab\x03${ESC}[A${ESC}[200~p${ESC}[201~${LEADER}${LEADER}`, TABS);
    expect(actions.every((action) => action.type === 'drop')).toBe(true);
    expect(actions.at(-1)).toEqual({ type: 'drop', reason: 'tabStrip' });
  });

  it('keeps the direct keys and the leader', () => {
    expect(run(`${ESC}[21~`, TABS)).toEqual([{ type: 'focusSidebar' }]);
    expect(run(`${LEADER}p`, TABS).at(-1)).toEqual({ type: 'focusPane' });
  });
});

describe('createDispatcher: the task explorer tab', () => {
  const EXPLORER: DispatchContext = { mode: 'view', agentTab: false, explorer: 'live' };
  const EXPLORER_MESSAGE: DispatchContext = { mode: 'view', agentTab: false, explorer: 'message' };

  it('lets the explorer own its keys, Esc, q, Ctrl-D and Ctrl-C included, and closes it on Ctrl-] alone', () => {
    expect(types(run('\x1d', EXPLORER))).toEqual(['closeTab']);
    expect(forwarded(run(`jk\r${ESC}[A${ESC}[Dhsfi`, EXPLORER))).toEqual(['j', 'k', '\r', `${ESC}[A`, `${ESC}[D`, 'h', 's', 'f', 'i']);
    expect(forwarded(run(`${ESC}`, EXPLORER))).toEqual([ESC]);
    expect(forwarded(run('q\x04\x03\x7f', EXPLORER))).toEqual(['q', '\x04', '\x03', '\x7f']);
    expect(modeNotice(EXPLORER)).toBe('[tasks] Ctrl-] or ×: close');
  });

  it('closes an explorer that shows a message on the close keys of view mode and drops other keys', () => {
    for (const key of ['q', ESC, '\x04', '\x03', '\x1d']) expect(types(run(key, EXPLORER_MESSAGE))).toEqual(['closeTab']);
    expect(types(run('ji', EXPLORER_MESSAGE))).toEqual(['drop', 'drop']);
    expect(modeNotice(EXPLORER_MESSAGE)).toBe('[tasks] q/Esc: close');
    for (const context of [EXPLORER, EXPLORER_MESSAGE]) expect(modeNotice(context).length).toBeLessThanOrEqual(32);
  });

  it('keeps the cockpit keys and drops pastes and the leader twice', () => {
    expect(run(`${LEADER}e`, MASTER).at(-1)).toEqual({ type: 'explorer' });
    expect(run(`${LEADER}l`, EXPLORER).at(-1)).toEqual({ type: 'cycleTab', delta: 1 });
    expect(run(`${ESC}[23~`, EXPLORER)).toEqual([{ type: 'attention' }]); // F11
    expect(run(`${LEADER}${LEADER}`, EXPLORER).at(-1)).toEqual({ type: 'drop', reason: 'view' });
    expect(run(`${ESC}[200~text${ESC}[201~`, EXPLORER)).toEqual([{ type: 'drop', reason: 'view' }]);
    // The sidebar keeps the keys while it has the focus.
    expect(types(run('q', { ...EXPLORER, sidebar: true }))).toEqual(['drop']);
  });
});

describe('cursorKeyMirror', () => {
  it('writes DECCKM only when the mode changes', () => {
    const writes: string[] = [];
    const mirror = cursorKeyMirror((data) => writes.push(data));
    mirror(false);
    mirror(true);
    mirror(true);
    mirror(false);
    expect(writes).toEqual([`${ESC}[?1h`, `${ESC}[?1l`]);
  });
});
