export const TMUX_TMPDIR_PREFIX: string;
/** A short base for test tmux socket directories (`/tmp` on POSIX), whatever TMPDIR is. */
export function tmuxTmpBase(): string;
/** The longest socket path a Unix socket takes (104 bytes on macOS, including the NUL). */
export const SOCKET_PATH_MAX_BYTES: number;
/** The byte length of tmux's socket for `-L name` under the current TMUX_TMPDIR, resolved as tmux resolves it. */
export function tmuxSocketPathBytes(name: string): number;
/** Points TMUX_TMPDIR at a fresh directory; the returned teardown kills its servers and removes it. */
export function setup(): () => void;
