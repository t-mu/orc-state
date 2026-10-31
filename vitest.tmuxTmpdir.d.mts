export const TMUX_TMPDIR_PREFIX: string;
/** Points TMUX_TMPDIR at a fresh directory; the returned teardown kills its servers and removes it. */
export function setup(): () => void;
