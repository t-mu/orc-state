import { describe, expect, it } from 'vitest';
import { DEFAULT_COCKPIT_KEYS, type CockpitKeys } from '../cockpitKeys.ts';
import { createDispatcher, cursorKeyMirror, modeNotice, sidebarKeyName, type DispatchAction, type DispatchContext } from './dispatch.ts';
import { createTokenizer, type Token } from './input.ts';

const ESC = '\x1b';
const F12 = `${ESC}[24~`;
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

describe('createDispatcher: cockpit keys and the prefix table', () => {
  it('forwards ordinary keys to the master byte-exact, a lone Esc included', () => {
    const actions = run(`ls\r${ESC}[A${ESC}OB${ESC}x\x7f`, MASTER);
    expect(forwarded(actions)).toEqual(['l', 's', '\r', `${ESC}[A`, `${ESC}OB`, `${ESC}x`, '\x7f']);
    expect(forwarded(run(ESC, MASTER))).toEqual([ESC]);
  });

  it('runs every prefix-table key', () => {
    const table = [...'donp&NPt123456789'].map((key) => run(`${F12}${key}`, MASTER).at(-1));
    expect(table).toEqual([
      { type: 'quit' }, { type: 'switchFocus' }, { type: 'cycleTab', delta: 1 }, { type: 'cycleTab', delta: -1 },
      { type: 'closeTab' }, { type: 'cycleProject', delta: 1 }, { type: 'cycleProject', delta: -1 }, { type: 'explorer' },
      ...Array.from({ length: 9 }, (_, index) => ({ type: 'selectTab', index: index + 1 })),
    ]);
  });

  it('sends the prefix to the pane when pressed twice, and drops an unbound key after it', () => {
    expect(forwarded(run(`${F12}${F12}`, MASTER))).toEqual([F12]);
    const actions = run(`${F12}xy`, MASTER);
    expect(actions[1]).toEqual({ type: 'drop', reason: 'prefix' });
    expect(forwarded(actions)).toEqual(['y']); // only the key after the prefix is taken
  });

  it('takes the prefix from the keys setting', () => {
    const keys = { ...DEFAULT_COCKPIT_KEYS, prefix: 'C-a' };
    expect(forwarded(run('\x01\x01', MASTER, keys))).toEqual(['\x01']);
    expect(run('\x01n', MASTER, keys).at(-1)).toEqual({ type: 'cycleTab', delta: 1 });
    expect(forwarded(run(F12, MASTER, keys))).toEqual([F12]); // F12 is an ordinary key now
  });

  it('runs the direct keys and the quit key in every mode', () => {
    for (const context of [MASTER, VIEW, TYPING]) {
      expect(run(`${ESC}OP${ESC}[20~${ESC}[21~${ESC}[23~\x11`, context)).toEqual([
        { type: 'selectTab', index: 1 }, { type: 'selectTab', index: 9 }, { type: 'focusSidebar' }, { type: 'attention' }, { type: 'quit' },
      ]);
    }
  });

  it('leaves a direct key that is unbound, and the quit key set to none, to the pane', () => {
    const keys: CockpitKeys = { ...DEFAULT_COCKPIT_KEYS, direct: { ...DEFAULT_COCKPIT_KEYS.direct, tab1: null }, quit: null };
    expect(forwarded(run(`${ESC}OP\x11`, MASTER, keys))).toEqual([`${ESC}OP`, '\x11']);
  });

  it('drops incomplete sequences in every mode, prefix pending or not', () => {
    const incomplete: Token = { kind: 'incomplete', raw: Buffer.from(`${ESC}[1;`) };
    for (const context of [MASTER, VIEW, TYPING]) {
      const dispatcher = createDispatcher(DEFAULT_COCKPIT_KEYS);
      expect(dispatcher.dispatch(incomplete, context)).toEqual({ type: 'drop', reason: 'incomplete' });
      dispatcher.dispatch(tokens(F12)[0], context);
      expect(dispatcher.dispatch(incomplete, context)).toEqual({ type: 'drop', reason: 'incomplete' });
      expect(dispatcher.prefixPending).toBe(true);
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

  it('sends the prefix twice only to a tab in typing mode', () => {
    expect(forwarded(run(`${F12}${F12}`, TYPING))).toEqual([F12]);
    expect(run(`${F12}${F12}`, VIEW).at(-1)).toEqual({ type: 'drop', reason: 'view' });
  });

  it('pastes in typing mode and drops a paste in view mode', () => {
    const paste = `${ESC}[200~one\ntwo${ESC}[201~`;
    for (const context of [MASTER, TYPING]) {
      const [action] = run(paste, context);
      expect(action.type === 'paste' && action.data.toString()).toBe('one\ntwo');
    }
    expect(run(paste, VIEW)).toEqual([{ type: 'drop', reason: 'view' }]);
  });

  it('a paste right after the prefix ends the prefix and is pasted', () => {
    const dispatcher = createDispatcher(DEFAULT_COCKPIT_KEYS);
    const actions = tokens(`${F12}${ESC}[200~x${ESC}[201~d`).map((token) => dispatcher.dispatch(token, MASTER));
    expect(types(actions)).toEqual(['drop', 'paste', 'forward']);
  });

  it('names the focus or the mode and its keys, short enough to leave the 80-column footer room', () => {
    expect(modeNotice(VIEW)).toBe('[view] i: type · q/Esc: close');
    expect(modeNotice(TYPING)).toBe('[typing] Ctrl-]: stop typing');
    expect(modeNotice(MASTER)).toContain('master');
    expect(modeNotice({ ...VIEW, sidebar: true })).toBe('↑↓ Tab · Enter: open · Space: expand · Esc: pane');
    for (const context of [VIEW, TYPING, MASTER]) expect(modeNotice(context).length).toBeLessThanOrEqual(32);
    // The sidebar's keys are the most: still under 50 columns, which leaves an 80-column footer its breadcrumb.
    expect(modeNotice({ ...MASTER, sidebar: true }).length).toBeLessThanOrEqual(48);
  });
});

describe('createDispatcher: sidebar focus', () => {
  const SIDEBAR: DispatchContext = { ...TYPING, sidebar: true };

  it('turns arrows, j/k, Tab, Shift-Tab, Enter and Esc into sidebar navigation', () => {
    expect(run(`${ESC}[A${ESC}OBkj\t${ESC}[Z\r${ESC}`, SIDEBAR)).toEqual([
      { type: 'sidebar', key: 'up' }, { type: 'sidebar', key: 'down' }, { type: 'sidebar', key: 'up' }, { type: 'sidebar', key: 'down' },
      { type: 'sidebar', key: 'switchBox' }, { type: 'sidebar', key: 'switchBox' }, { type: 'sidebar', key: 'open' }, { type: 'sidebar', key: 'back' },
    ]);
  });

  it('turns Space into the toggle key, and only while the sidebar has the focus: in the slot it reaches the pane', () => {
    expect(run(' ', SIDEBAR)).toEqual([{ type: 'sidebar', key: 'toggle' }]);
    expect(forwarded(run(' ', TYPING))).toEqual([' ']);
    expect(forwarded(run(' ', MASTER))).toEqual([' ']);
    expect(run(' ', VIEW)).toEqual([{ type: 'drop', reason: 'view' }]);
    expect([sidebarKeyName('open'), sidebarKeyName('toggle')]).toEqual(['Enter', 'Space']);
  });

  it('lets no key, paste or doubled prefix reach the pane, even from a typing tab', () => {
    const actions = run(`xiq\x1d${ESC}[200~p${ESC}[201~${F12}${F12}`, SIDEBAR);
    expect(actions.every((action) => action.type === 'drop')).toBe(true);
    expect(actions.at(-1)).toEqual({ type: 'drop', reason: 'sidebar' });
  });

  it('keeps the cockpit keys and the prefix table', () => {
    expect(run('\x11', SIDEBAR)).toEqual([{ type: 'quit' }]);
    expect(run(`${F12}o`, SIDEBAR).at(-1)).toEqual({ type: 'switchFocus' });
    expect(run(`${ESC}OP`, SIDEBAR)).toEqual([{ type: 'selectTab', index: 1 }]);
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

  it('keeps the cockpit keys and drops pastes and the prefix twice', () => {
    expect(run(`${F12}t`, MASTER).at(-1)).toEqual({ type: 'explorer' });
    expect(run(`${F12}n`, EXPLORER).at(-1)).toEqual({ type: 'cycleTab', delta: 1 });
    expect(run(`${ESC}[23~`, EXPLORER)).toEqual([{ type: 'attention' }]); // F11
    expect(run(`${F12}${F12}`, EXPLORER).at(-1)).toEqual({ type: 'drop', reason: 'view' });
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
