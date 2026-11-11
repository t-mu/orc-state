/**
 * Key handling of `orc terminal --view-first` (standalone view-first mode; the
 * cockpit's agent tabs use the same keys): it opens in view mode, where no key
 * reaches the agent, and switches to typing mode only on `i`.
 */

/** `starting`: `i` was pressed and the lease is on its way; every key is dropped. */
export type TerminalMode = 'view' | 'starting' | 'typing';

export type TerminalKeyAction =
  | { type: 'close' }
  | { type: 'start-typing' }
  | { type: 'stop-typing' }
  | { type: 'send'; data: string }
  | { type: 'ignore' };

/** Ctrl-]: closes the tab in view mode, stops typing in typing mode. */
export const STOP_KEY = '\x1d';

/** q, Esc, Ctrl-D, Ctrl-C and Ctrl-] close a tab in view mode. */
const CLOSE_KEYS = new Set(['q', '\x1b', '\x04', '\x03', STOP_KEY]);

/** The exit code of `orc terminal --view-first` when its user closed it (any other end is unexpected). */
export const TERMINAL_CLOSED_EXIT = 10;

/** One line naming the mode and its keys. */
export const MODE_NOTICE: Record<TerminalMode, string> = {
  view: '[view] i: type · q/Esc/Ctrl-D/Ctrl-C/Ctrl-]: close tab',
  starting: '[starting to type…]',
  typing: '[typing → agent] Ctrl-]: stop typing',
};

/** What a chunk of keyboard input does in `mode`. */
export function terminalKeyAction(mode: TerminalMode, data: string): TerminalKeyAction {
  if (mode === 'starting') return { type: 'ignore' };
  if (mode === 'typing') return data === STOP_KEY ? { type: 'stop-typing' } : { type: 'send', data };
  if (CLOSE_KEYS.has(data)) return { type: 'close' };
  return data === 'i' ? { type: 'start-typing' } : { type: 'ignore' };
}
