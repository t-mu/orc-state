# Terminal streaming: tmux control mode findings

- Prototype: `node scripts/prototypes/tmux-control.ts [--tui=claude|vim|top] [--dump]`; prints JSON, touches no orc state.
- Private server: `-S <tmpdir>/sock -f /dev/null`, `ORC_*`/`TMUX` stripped from the environment.
- Setup: two 100x30 sessions `a1`/`a2`, one `tmux -C` client per session.
- Measured on tmux 3.3a, 2026-11-07.

## Results

| # | Question | Observed |
|---|---|---|
| 1 | Control client gets only its attached session's output? | Yes. Client on `a1` saw only pane `%0`, never the `a2` marker; client on `a2` saw only `%1`. First `%output` 3–4 ms after `send-keys` (2 runs). |
| 2 | Attaching resizes the agent window? | Attach alone: no (100x30 stays). `refresh-client -C 80x24` with default `window-size latest`: **yes**, window shrank to 80x24. With `window-size manual`: `-C 120x40` left it at 100x30. With client flag `ignore-size` (default `window-size`): `-C 70x20` left it at 100x30. |
| 3 | Minimum tmux version | `attach -f`/`refresh-client -f`, `ignore-size`, `pause-after`, `%extended-output`: **3.2**. `window-size manual` and `resize-window`: 2.9. Control clients don't affect size until `refresh-client -C`: 2.6. Installed: **3.3a**. |
| 4 | Snapshot + stream + resize redraws cleanly? | Yes. Resizing to 99 cols and back makes the TUI repaint the whole screen. Replaying snapshot + cursor + stream through a small VT model, then comparing with `capture-pane`: see table below. |
| 5 | `%output` escaping | Bytes < 0x20 and `\` become 3-digit octal `\ooo`; everything else, UTF-8 included, is raw. `T\tE ESC[1m B\ U ä€ Z CRLF` arrived as `T\011E\033[1mB\134U<raw c3a4 e282ac>Z\015\012`. |

### Q4 detail (30 rows)

| TUI | Snapshot bytes | Redraw bytes | How it repaints | Wrong rows: snapshot+stream | Wrong rows: stream only |
|---|---|---|---|---|---|
| `claude` (trust dialog) | 1006 | 2767 | `ESC[H`, then `ESC[2K` on every row, then repaints | 0 | 0 |
| `vim` | 1722 | 3054 | `ESC[H ESC[J`, then repaints | 0 | 0 |
| `top` | 2612 | 16236 | `ESC[H`, rewrites each line ending in `ESC[K` | 1 | 1 |

- `top`: the one wrong row is either a live value changing or the bottom-right cursor edge case
  (`cursor_x` = 100 = width). The 3 s refresh repaints it anyway.
- After a forced resize, the stream alone rebuilds the screen. The snapshot only covers the time
  before the redraw arrives, and TUIs that ignore SIGWINCH.

### Decoding `%output`

- Read the client's stdout as **bytes**, split on `\n`, take the payload after `%output %<pane> `
  (or after ` : ` in `%extended-output %<pane> <age> ... : `).
- Replace `\\([0-7]{3})` with that byte; pass all other bytes through. Feed the result to xterm.js as
  `Uint8Array`. Don't UTF-8-decode per line: a multi-byte char may be split across `%output` lines.
- Command replies come between `%begin`/`%end`|`%error`, in FIFO order. The first block answers the
  attach itself. Notifications never appear inside a block.
- `refresh-client -f pause-after=N` was accepted; output then arrives as `%extended-output %0 0 : ...`.
- Killing the attached session sends `%exit` to its client.

## Recommended design

| Decision | Choice | Why |
|---|---|---|
| Clients | **One `tmux -C attach -t =<session>` per viewed agent**, started on first viewer and shared by every viewer of that agent | Output is per attached session (Q1) |
| Sizing | Attach with `-f ignore-size` (`read-only,ignore-size` not tested); never send `refresh-client -C`; viewer uses the pane size from `#{pane_width}x#{pane_height}` | Without it, `-C` resizes the worker under `window-size latest` (Q2) |
| Snapshot | `capture-pane -e -p` + `display -p '#{cursor_x} #{cursor_y}'` → write, `CSI y;x H`, then stream; for a clean full-screen state, `resize-window -x W-1` then `-x W` to force a redraw | 0 wrong rows for `claude`/`vim` (Q4); `resize-window` sets `window-size manual`, `setw -u window-size` undoes it |
| Backpressure | `refresh-client -f pause-after=<s>`; resume with `refresh-client -A '%<pane>:continue'` (pausing not exercised) | Keeps a slow viewer from buffering without limit |
| Min tmux | **3.2**, which orc requires for every session (`MIN_TMUX_VERSION`, checked by `orc doctor` and `orc start-session`); there is no polling fallback | `-f` flags, `ignore-size`, `pause-after` (Q3) |

## Implementation (v1/terminal-streams)

- `lib/terminalHost.ts`: `%output` decoding, the control-line parser, and `TerminalStreams` (one connection per terminal, shared by its viewers). `TmuxTerminalDriver.connect` in `lib/terminalBroker.ts` is the `tmux -C attach-session -f ignore-size` client.
- Sizing: viewers never send `refresh-client -C`; the lease holder (or the first viewer when no one holds the lease) sizes the pane with `resize-window` (which sets `window-size manual`), first one column short and back so the TUI redraws.
- Resize: tmux `%layout-change` becomes a `resize` frame (`columns`, `rows`) to every viewer when the size changed; a viewer repaints. `orc terminal` ignores it. Clients ignore frame types and fields they do not know.
- Targets: a run's provider terminal (`POST /v1/terminals/provider { run_id }`) or any agent's running session by `{ agent_id }`, including the master and scouts, which have no run (`ControlClient.openAgentTerminal`, `orc terminal <agent_id>`). Both return a `provider:<session_id>` id that streams, leases and takes input the same way.
- Exit: `%exit`, a lost client, or the pane found dead (checked every second; a worker pane kept by `remain-on-exit` sends no `%exit`) ends the stream with an `exit` frame.
- Snapshot overlap: output already queued in the control client's pipe when a viewer's snapshot is taken reaches that viewer after the snapshot, so a few bytes may be applied twice. The redraw that follows the size change, or the TUI's next repaint, corrects the screen.
- `orc terminal`: a viewer without the lease sizes the pane only when it opens. Later local resizes are sent only by a `--write` viewer.
- Input ordering: the server applies each `POST /v1/terminals/<id>/input` as it arrives, so concurrent requests can overtake each other. `ControlClient.inputTerminal` queues inputs per terminal within one client and sends the next only after the previous one settled, so one client's inputs reach a terminal in call order. A failed input is not retried and does not stop later ones; aborting a queued input drops it unsent. A caller that retries an input (after the retryable `busy`) re-queues it behind anything queued meanwhile, so it must not queue the next input until the retry settles; `orc terminal` sends one input at a time for this reason. Inputs from different clients, or to different terminals, are not ordered against each other.
- Backpressure: `pause-after` is not used yet; a viewer more than 8 MiB behind gets a final `exit` frame with reason `backlog` and reopens.
