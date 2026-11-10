/**
 * Keeps an agent's mouse tracking out of the terminal that relays its pane:
 * DEC private mode set/reset sequences drop their mouse modes, everything else
 * passes through unchanged.
 */

/** X10, normal/highlight/button/any-motion tracking and the UTF-8, SGR, urxvt and SGR-pixel encodings. */
const MOUSE_MODES = new Set(['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016']);

/** Turns off any mouse reporting a terminal was left in. */
export const MOUSE_RESET = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';

/** Longest unfinished sequence held back for the next chunk; a longer one is passed on as it is. */
const MAX_HELD = 32;

const MODE_SEQUENCE = /\x1b\[\?([0-9;]+)([hl])/g;
/** A tail that may still become a mode sequence. */
const PARTIAL_TAIL = /\x1b(?:\[(?:\?[0-9;]*)?)?$/;

function stripMouseModes(text: string): string {
  return text.replace(MODE_SEQUENCE, (_match, params: string, final: string) => {
    const kept = params.split(';').filter((param) => !MOUSE_MODES.has(param));
    return kept.length ? `\x1b[?${kept.join(';')}${final}` : '';
  });
}

/** A streaming filter; a sequence split across chunks is held back and handled with the next one. */
export class TerminalMouseFilter {
  private held = '';

  filter(chunk: string): string {
    const text = this.held + chunk;
    const tail = PARTIAL_TAIL.exec(text);
    const cut = tail && text.length - tail.index <= MAX_HELD ? tail.index : text.length;
    this.held = text.slice(cut);
    return stripMouseModes(text.slice(0, cut));
  }
}
