import { describe, expect, it } from 'vitest';
import { DEFAULT_COCKPIT_KEYS, isTmuxKeyName, resolveCockpitKeys } from './cockpitKeys.ts';

describe('resolveCockpitKeys', () => {
  it('defaults to F12 and function keys, none of them Ctrl-], Alt or an AltGr character', () => {
    const { keys, problems } = resolveCockpitKeys({});
    expect(problems).toEqual([]);
    expect(keys).toEqual(DEFAULT_COCKPIT_KEYS);
    expect(keys.prefix).toBe('F12');
    expect(Object.values(keys.direct)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11']);
  });

  it('takes the prefix and direct keys from the environment', () => {
    const { keys, problems } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: ' C-a ', ORC_COCKPIT_KEYS: 'tab1=M-1, dashboard=C-F10,attention=none' });
    expect(problems).toEqual([]);
    expect(keys.prefix).toBe('C-a');
    expect(keys.direct).toMatchObject({ tab1: 'M-1', tab2: 'F2', dashboard: 'C-F10', attention: null });
  });

  it('reports invalid keys and entries and keeps the defaults', () => {
    const { keys, problems } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'Ctrl-]', ORC_COCKPIT_KEYS: 'tab1=a,tab2=Hyper-x,bogus=F3,tab4' });
    expect(keys).toEqual(DEFAULT_COCKPIT_KEYS);
    expect(problems).toEqual([
      "ORC_COCKPIT_PREFIX: unknown key 'Ctrl-]'; using F12",
      "ORC_COCKPIT_KEYS: 'a' cannot be the tab1 key (a function key F1-F12, or a C- or M- key); using F1",
      "ORC_COCKPIT_KEYS: 'Hyper-x' cannot be the tab2 key (a function key F1-F12, or a C- or M- key); using F2",
      expect.stringContaining("unknown entry 'bogus=F3'"),
      expect.stringContaining("unknown entry 'tab4'"),
    ]);
  });

  it('drops a direct key that is the prefix or another action\'s key', () => {
    const { keys, problems } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'F1', ORC_COCKPIT_KEYS: 'attention=F10' });
    expect(keys.direct).toMatchObject({ tab1: null, dashboard: 'F10', attention: null });
    expect(problems).toEqual([
      "ORC_COCKPIT_KEYS: F1 is already the prefix or another action's key; tab1 has no direct key",
      "ORC_COCKPIT_KEYS: F10 is already the prefix or another action's key; attention has no direct key",
    ]);
  });
});

describe('the cockpit quit key', () => {
  it('defaults to C-q and is set or unbound with quit=<key> in ORC_COCKPIT_KEYS', () => {
    expect(resolveCockpitKeys({}).keys.quit).toBe('C-q');
    expect(resolveCockpitKeys({ ORC_COCKPIT_KEYS: 'quit=C-x' })).toMatchObject({ keys: { quit: 'C-x' }, problems: [] });
    expect(resolveCockpitKeys({ ORC_COCKPIT_KEYS: 'quit=none' }).keys.quit).toBeNull();
  });

  it('rejects a plain key and drops one that clashes with the prefix or a direct key, leaving them unchanged', () => {
    const plain = resolveCockpitKeys({ ORC_COCKPIT_KEYS: 'quit=q' });
    expect(plain.keys.quit).toBe('C-q');
    expect(plain.problems).toEqual([expect.stringContaining("'q' cannot be the quit key")]);
    const clash = resolveCockpitKeys({ ORC_COCKPIT_KEYS: 'quit=F10' });
    expect(clash.keys.quit).toBeNull();
    expect(clash.keys.direct.dashboard).toBe('F10');
    expect(clash.problems).toEqual([expect.stringContaining('there is no direct quit key')]);
  });

  it('drops the default quit key silently when the prefix or a direct key is C-q, so orc start-session warns about nothing new', () => {
    expect(resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'C-q' })).toEqual({ keys: expect.objectContaining({ prefix: 'C-q', quit: null }), problems: [] });
    expect(resolveCockpitKeys({ ORC_COCKPIT_KEYS: 'dashboard=C-q' })).toMatchObject({ keys: { quit: null }, problems: [] });
  });
});

describe('isTmuxKeyName', () => {
  it('accepts tmux key names and rejects the rest', () => {
    for (const key of ['F12', 'f5', 'C-]', 'M-x', 'C-M-Left', 'PageUp', '&']) expect(isTmuxKeyName(key)).toBe(true);
    for (const key of ['', 'F13', 'Ctrl-a', 'C-', 'ö', 'two']) expect(isTmuxKeyName(key)).toBe(false);
  });
});
