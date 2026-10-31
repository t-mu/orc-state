/**
 * A scout report drawn the way Claude Code's TUI draws it (recorded from a real
 * tmux scout's pty log, 2026-10-31): each line starts with a carriage return,
 * a cursor move right past the 2-column indent and a cursor move down, and
 * words inside a line are placed by absolute column moves rather than spaces.
 * No newline separates the report's lines.
 */
export const TUI_REPORT_LINES = [
  'SCOUT_REPORT',
  'findings:',
  'the lease expired before the worker renewed it',
  '',
  'likely_cause:',
  'clock skew between coordinator and worker',
  '',
  'recommended_action:',
  'reset the task and requeue it',
  'SCOUT_REPORT_END',
];

/** Place each word with an absolute column move, as the TUI does. */
function drawLine(line: string): string {
  let column = 3;
  return line.split(' ').map((word, index) => {
    const placed = index === 0 ? word : `\x1b[${column}G${word}`;
    column += word.length + 1;
    return placed;
  }).join('') + '\x1b[K';
}

/** The report as raw TUI bytes, starting at the top of an area of `TUI_REPORT_LINES.length` reserved rows. */
export function tuiScoutReportBytes(): string {
  return TUI_REPORT_LINES.map((line, index) => `${index === 0 ? '\r\x1b[2C' : '\r\x1b[2C\x1b[1B'}${drawLine(line)}`).join('');
}

/** What `tmux capture-pane -p -J` shows for the same report: each marker on its own line, indented by 2 spaces. */
export function capturedScoutReport(): string {
  return TUI_REPORT_LINES.map((line) => (line ? `  ${line}` : '')).join('\n');
}
