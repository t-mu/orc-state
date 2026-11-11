/**
 * lib/cockpitKeys.ts
 *
 * The cockpit's keys as tmux key names (`F12`, `C-a`, `M-1`, `C-F10`): the
 * defaults, `ORC_COCKPIT_PREFIX` / `ORC_COCKPIT_KEYS` resolution and the hint
 * shown to the user. Pure: the tmux cockpit (adapters/tmuxCockpit.ts) binds
 * them, cockpit2 matches them against raw input (lib/cockpit2/input.ts).
 */

// ── Keys ─────────────────────────────────────────────────────────────────────
// Defaults are function keys: they need no Option/Alt/AltGr on any keyboard layout.

/** The direct keys' actions: `tab1`..`tab9` select that tab of the active project, `dashboard` focuses the sidebar, `attention` shows the next agent needing attention. */
export const COCKPIT_ACTIONS = ['tab1', 'tab2', 'tab3', 'tab4', 'tab5', 'tab6', 'tab7', 'tab8', 'tab9', 'dashboard', 'attention'] as const;
export type CockpitAction = typeof COCKPIT_ACTIONS[number];

export interface CockpitKeys {
  /** The tmux prefix: prefix + d/o as in tmux, n/p/&/1-9 for the active project's tabs, N/P for projects; pressed twice, it reaches the pane. */
  prefix: string;
  /** Keys bound without the prefix; null leaves the action to the prefix table only. */
  direct: Record<CockpitAction, string | null>;
  /**
   * cockpit2's direct quit key (`quit=<key>` in `ORC_COCKPIT_KEYS`); null leaves only prefix then d.
   * Kept out of `direct`: the tmux cockpit binds every direct key and has no quit action.
   */
  quit: string | null;
}

export const DEFAULT_COCKPIT_KEYS: CockpitKeys = {
  prefix: 'F12',
  direct: {
    tab1: 'F1', tab2: 'F2', tab3: 'F3', tab4: 'F4', tab5: 'F5', tab6: 'F6', tab7: 'F7', tab8: 'F8', tab9: 'F9',
    dashboard: 'F10', attention: 'F11',
  },
  quit: 'C-q',
};

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/i;
const NAMED_KEY = /^(F([1-9]|1[0-2])|Home|End|PageUp|PgUp|PPage|PageDown|PgDn|NPage|Insert|IC|Delete|DC|Up|Down|Left|Right|Tab|BTab|Space|Enter|Escape|BSpace)$/i;

/** Whether tmux knows `key`: optional C-/M-/S- modifiers, then a named key or one printable ASCII character. */
export function isTmuxKeyName(key: string): boolean {
  const base = key.replace(/^([CMS]-)+(?=.)/, '');
  return NAMED_KEY.test(base) || /^[!-~]$/.test(base);
}

/** A direct key is bound for every pane: unmodified, only a function key, so typing never reaches the cockpit by accident. */
function isDirectKeyName(key: string): boolean {
  return isTmuxKeyName(key) && (FUNCTION_KEY.test(key) || /^[CM]-/.test(key));
}

/**
 * The cockpit keys from `ORC_COCKPIT_PREFIX` (a tmux key name) and
 * `ORC_COCKPIT_KEYS` (`action=key` pairs, comma-separated; `none` unbinds a
 * direct key; `quit=<key>` sets cockpit2's quit key). Anything invalid is
 * reported in `problems` and its default kept; a direct key that clashes with
 * the prefix or an earlier direct key is dropped, and so is a quit key that
 * clashes with any of them.
 */
export function resolveCockpitKeys(env: NodeJS.ProcessEnv = process.env): { keys: CockpitKeys; problems: string[] } {
  const problems: string[] = [];
  let prefix = DEFAULT_COCKPIT_KEYS.prefix;
  const rawPrefix = env.ORC_COCKPIT_PREFIX?.trim();
  if (rawPrefix) {
    if (isTmuxKeyName(rawPrefix)) prefix = rawPrefix;
    else problems.push(`ORC_COCKPIT_PREFIX: unknown key '${rawPrefix}'; using ${prefix}`);
  }
  const direct = { ...DEFAULT_COCKPIT_KEYS.direct };
  let quit = DEFAULT_COCKPIT_KEYS.quit;
  for (const entry of (env.ORC_COCKPIT_KEYS ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const split = entry.indexOf('=');
    const action = entry.slice(0, split).trim();
    const key = entry.slice(split + 1).trim();
    if (split >= 0 && action === 'quit') {
      if (key.toLowerCase() === 'none') quit = null;
      else if (isDirectKeyName(key)) quit = key;
      else problems.push(`ORC_COCKPIT_KEYS: '${key}' cannot be the quit key (a function key F1-F12, or a C- or M- key); using ${quit ?? 'none'}`);
      continue;
    }
    if (split < 0 || !(COCKPIT_ACTIONS as readonly string[]).includes(action)) {
      problems.push(`ORC_COCKPIT_KEYS: unknown entry '${entry}' (expected <action>=<key>, actions: ${COCKPIT_ACTIONS.join(', ')}, quit)`);
      continue;
    }
    const name = action as CockpitAction;
    if (key.toLowerCase() === 'none') direct[name] = null;
    else if (isDirectKeyName(key)) direct[name] = key;
    else problems.push(`ORC_COCKPIT_KEYS: '${key}' cannot be the ${name} key (a function key F1-F12, or a C- or M- key); using ${direct[name] ?? 'none'}`);
  }
  const taken = new Set([prefix.toLowerCase()]);
  for (const action of COCKPIT_ACTIONS) {
    const key = direct[action];
    if (key == null) continue;
    if (taken.has(key.toLowerCase())) {
      problems.push(`ORC_COCKPIT_KEYS: ${key} is already the prefix or another action's key; ${action} has no direct key`);
      direct[action] = null;
    } else {
      taken.add(key.toLowerCase());
    }
  }
  if (quit != null && taken.has(quit.toLowerCase())) {
    problems.push(`ORC_COCKPIT_KEYS: ${quit} is already the prefix or another action's key; there is no direct quit key`);
    quit = null;
  }
  return { keys: { prefix, direct, quit }, problems };
}

/** How a tmux key name reads in a hint: `C-x` as `Ctrl-x`, `M-x` as `Alt-x`. */
export function keyLabel(key: string): string {
  return key.replace(/^((?:[CMS]-)+)(?=.)/, (mods) => mods.replace(/C-/g, 'Ctrl-').replace(/M-/g, 'Alt-').replace(/S-/g, 'Shift-'));
}

/** How to get around, shown on attach and in the status line. */
export function cockpitKeysHint(keys: CockpitKeys): string {
  const prefix = keyLabel(keys.prefix);
  const tabs = COCKPIT_ACTIONS.slice(0, 9).map((action) => keys.direct[action]).filter((key): key is string => key != null);
  return [
    ...(tabs.length > 0 ? [`${tabs.length > 1 ? `${keyLabel(tabs[0])}-${keyLabel(tabs.at(-1)!)}` : keyLabel(tabs[0])}: tab`] : []),
    ...(keys.direct.dashboard ? [`${keyLabel(keys.direct.dashboard)}: sidebar`] : []),
    `${prefix} o: switch pane`,
    `${prefix} n/p: next/previous tab`,
    `${prefix} N/P: project`,
    `${prefix} d: detach`,
  ].join(' | ');
}
