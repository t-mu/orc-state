// Vitest globalSetup shared by every vitest config. tmux keeps its sockets in
// `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/` and, as of 3.3a, never unlinks them when a
// server exits. Each test state dir gets its own private orc server, so without
// this every test run leaked socket files into the user's real tmux directory
// (and a test could reach a live orc server). Pointing TMUX_TMPDIR at a
// throwaway directory before any test worker starts — workers inherit the
// environment — keeps tests away from the real directory; teardown kills any
// server a test left behind and removes the directory.
//
// The directory lives under /tmp, not tmpdir(): a Unix socket path is limited
// to 104 bytes on macOS (108 on Linux), and macOS's tmpdir() is a long
// /var/folders/... path that pushes `<dir>/tmux-<uid>/<name>` past the limit.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TMUX_TMPDIR_PREFIX = 'orc-test-tmux-';

/** A short base for test tmux socket directories, whatever TMPDIR is. */
export function tmuxTmpBase() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

export function setup() {
  // A fresh directory, never the real TMUX_TMPDIR.
  const dir = mkdtempSync(join(tmuxTmpBase(), TMUX_TMPDIR_PREFIX));
  process.env.TMUX_TMPDIR = dir;
  return () => teardown(dir);
}

function teardown(dir) {
  let sockets = [];
  try {
    sockets = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isSocket())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch { /* nothing was created */ }
  for (const socket of sockets) spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 5_000 });
  rmSync(dir, { recursive: true, force: true });
}
