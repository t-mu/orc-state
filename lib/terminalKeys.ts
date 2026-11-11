/**
 * Key handling of `orc terminal --view-first` (a cockpit agent tab): it opens
 * in view mode, where no key reaches the agent, and switches to typing mode
 * only on `i`.
 */

export type TerminalMode = 'view' | 'typing';

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
  view: '[view] i: type · q/Esc/Ctrl-D: close tab',
  typing: '[typing → agent] Ctrl-]: stop typing',
};

/** What a chunk of keyboard input does in `mode`. */
export function terminalKeyAction(mode: TerminalMode, data: string): TerminalKeyAction {
  if (mode === 'typing') return data === STOP_KEY ? { type: 'stop-typing' } : { type: 'send', data };
  if (CLOSE_KEYS.has(data)) return { type: 'close' };
  return data === 'i' ? { type: 'start-typing' } : { type: 'ignore' };
}
