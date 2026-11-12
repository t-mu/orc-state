export const TMUX_TMPDIR_PREFIX: string;
/** A short base for test tmux socket directories (`/tmp` on POSIX), whatever TMPDIR is. */
export function tmuxTmpBase(): string;
/** Points TMUX_TMPDIR at a fresh directory; the returned teardown kills its servers and removes it. */
export function setup(): () => void;
