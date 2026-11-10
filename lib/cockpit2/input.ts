/**
 * lib/cockpit2/input.ts
 *
 * Raw terminal input → tokens, and tokens → the cockpit's configured tmux key
 * names (lib/cockpitKeys.ts). Pure apart from the injectable timer that
 * flushes a lone ESC; every token keeps its raw bytes so it can be forwarded
 * to a pane unchanged.
 */
import { isTmuxKeyName } from '../cockpitKeys.ts';

const ESC = 0x1b;
const PASTE_START = '200';
const PASTE_END = Buffer.from('\x1b[201~', 'latin1');

/**
 * One unit of input. `paste`: a bracketed paste, `data` without its markers;
 * `mouse`: an SGR mouse report (lib/cockpit2/mouse.ts parses it); `csi`/`ss3`:
 * `ESC [` / `ESC O` sequences (`params` the parameter bytes, `final` the final
 * byte, `''` when cut short; the Linux console's `ESC [ [ A` has final `[A`;
 * `meta` when an extra ESC came first, rxvt's Meta);
 * `alt`: ESC and one key (`key` the character or control byte); `char`: one
 * UTF-8 character (`�` for an invalid byte); `control`: one C0 byte or DEL.
 */
export type Token =
  | { kind: 'paste'; raw: Buffer; data: Buffer }
  | { kind: 'mouse'; raw: Buffer }
  | { kind: 'csi'; raw: Buffer; params: string; intermediates: string; final: string; meta?: true }
  | { kind: 'ss3'; raw: Buffer; params: string; final: string; meta?: true }
  | { kind: 'alt'; raw: Buffer; key: string }
  | { kind: 'char'; raw: Buffer; text: string }
  | { kind: 'control'; raw: Buffer; code: number };

export interface TokenizerTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface TokenizerOptions {
  /** How long a held incomplete sequence (a lone ESC above all) waits for more bytes. */
  escTimeoutMs?: number;
  /** Receives what the timeout flushes. */
  onFlush?: (tokens: Token[]) => void;
  timers?: TokenizerTimers;
}

export interface Tokenizer {
  /** The tokens `chunk` completes; an incomplete sequence at its end is held for the next push or the timeout. */
  push(chunk: Buffer): Token[];
  /** Emits what is held as if no more bytes were coming (an unfinished paste stays held). */
  flush(): Token[];
}

type Scan = { token: Token | 'pasteStart'; end: number } | null;

const isFinal = (byte: number) => byte >= 0x40 && byte <= 0x7e;
const isParam = (byte: number) => byte >= 0x30 && byte <= 0x3f;
const isIntermediate = (byte: number) => byte >= 0x20 && byte <= 0x2f;
const isControl = (byte: number) => byte < 0x20 || byte === 0x7f;
const latin1 = (data: Buffer, start: number, end: number) => data.toString('latin1', start, end);

/** The byte length of the UTF-8 character `lead` starts, or 0 for a byte that cannot start one. */
function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** One character or control byte at `start`; null when a UTF-8 character is cut off and more may come. */
function scanChar(data: Buffer, start: number, final: boolean): { text: string; end: number; control: boolean } | null {
  const lead = data[start];
  if (isControl(lead)) return { text: String.fromCharCode(lead), end: start + 1, control: true };
  const length = utf8Length(lead);
  if (length === 0) return { text: '�', end: start + 1, control: false };
  let end = start + 1;
  while (end < start + length) {
    if (end >= data.length) return final ? { text: '�', end, control: false } : null;
    if ((data[end] & 0xc0) !== 0x80) return { text: '�', end, control: false };
    end += 1;
  }
  return { text: data.toString('utf8', start, end), end, control: false };
}

function scanCsi(data: Buffer, start: number, final: boolean): Scan {
  let at = start + 2;
  const raw = (end: number) => Buffer.from(data.subarray(start, end));
  if (at >= data.length) return final ? { token: { kind: 'alt', raw: raw(at), key: '[' }, end: at } : null;
  if (data[at] === 0x5b) {
    // Linux console function keys: ESC [ [ A .. ESC [ [ E.
    if (at + 1 >= data.length) return final ? { token: { kind: 'csi', raw: raw(at + 1), params: '', intermediates: '', final: '[' }, end: at + 1 } : null;
    return { token: { kind: 'csi', raw: raw(at + 2), params: '', intermediates: '', final: latin1(data, at, at + 2) }, end: at + 2 };
  }
  const paramsStart = at;
  while (at < data.length && isParam(data[at])) at += 1;
  const params = latin1(data, paramsStart, at);
  const intermediatesStart = at;
  while (at < data.length && isIntermediate(data[at])) at += 1;
  const intermediates = latin1(data, intermediatesStart, at);
  // rxvt ends Shift-function keys in `$` (ESC [ 24 $), an intermediate byte everywhere else; the
  // replies that use it (DECRPM `CSI 2004 ; 1 $ y`) have more than one parameter.
  if (intermediates === '$' && /^\d+$/.test(params)) {
    return { token: { kind: 'csi', raw: raw(at), params, intermediates: '', final: '$' }, end: at };
  }
  if (at >= data.length) return final ? { token: { kind: 'csi', raw: raw(at), params, intermediates, final: '' }, end: at } : null;
  if (!isFinal(data[at])) return { token: { kind: 'csi', raw: raw(at), params, intermediates, final: '' }, end: at };
  const finalByte = String.fromCharCode(data[at]);
  const end = at + 1;
  if (params.startsWith('<') && (finalByte === 'M' || finalByte === 'm') && intermediates === '') return { token: { kind: 'mouse', raw: raw(end) }, end };
  if (params === PASTE_START && finalByte === '~' && intermediates === '') return { token: 'pasteStart', end };
  return { token: { kind: 'csi', raw: raw(end), params, intermediates, final: finalByte }, end };
}

function scanSs3(data: Buffer, start: number, final: boolean): Scan {
  let at = start + 2;
  const raw = (end: number) => Buffer.from(data.subarray(start, end));
  if (at >= data.length) return final ? { token: { kind: 'alt', raw: raw(at), key: 'O' }, end: at } : null;
  while (at < data.length && isParam(data[at])) at += 1;
  const params = latin1(data, start + 2, at);
  if (at >= data.length) return final ? { token: { kind: 'ss3', raw: raw(at), params, final: '' }, end: at } : null;
  if (!isFinal(data[at])) return { token: { kind: 'ss3', raw: raw(at), params, final: '' }, end: at };
  return { token: { kind: 'ss3', raw: raw(at + 1), params, final: String.fromCharCode(data[at]) }, end: at + 1 };
}

/** The token at `start`; null when the bytes there may be the start of a longer one and `final` is false. */
function scan(data: Buffer, start: number, final: boolean): Scan {
  const byte = data[start];
  if (byte === ESC) {
    if (start + 1 >= data.length) return final ? { token: { kind: 'control', raw: Buffer.from([ESC]), code: ESC }, end: start + 1 } : null;
    const next = data[start + 1];
    if (next === 0x5b) return scanCsi(data, start, final);
    if (next === 0x4f) return scanSs3(data, start, final);
    if (next === ESC) {
      // rxvt sends Meta with a function or cursor key as an ESC before its sequence: ESC ESC [ 11 ~.
      if (start + 2 >= data.length && !final) return null;
      if (data[start + 2] === 0x5b || data[start + 2] === 0x4f) {
        const inner = data[start + 2] === 0x5b ? scanCsi(data, start + 1, final) : scanSs3(data, start + 1, final);
        if (!inner) return null;
        if (typeof inner.token !== 'string' && (inner.token.kind === 'csi' || inner.token.kind === 'ss3') && inner.token.final !== '') {
          return { token: { ...inner.token, raw: Buffer.from(data.subarray(start, inner.end)), meta: true }, end: inner.end };
        }
      }
      return { token: { kind: 'control', raw: Buffer.from([ESC]), code: ESC }, end: start + 1 };
    }
    const key = scanChar(data, start + 1, final);
    if (!key) return null;
    return { token: { kind: 'alt', raw: Buffer.from(data.subarray(start, key.end)), key: key.text }, end: key.end };
  }
  const char = scanChar(data, start, final);
  if (!char) return null;
  const raw = Buffer.from(data.subarray(start, char.end));
  return { token: char.control ? { kind: 'control', raw, code: byte } : { kind: 'char', raw, text: char.text }, end: char.end };
}

const defaultTimers: TokenizerTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createTokenizer(options: TokenizerOptions = {}): Tokenizer {
  const escTimeoutMs = options.escTimeoutMs ?? 25;
  const timers = options.timers ?? defaultTimers;
  /** Unparsed bytes outside a paste. */
  let pending = Buffer.alloc(0);
  /** Inside a bracketed paste: the content so far and the last bytes, which may begin the end marker. */
  let paste: { start: Buffer; chunks: Buffer[]; carry: Buffer } | null = null;
  let timer: unknown = null;

  /** Feeds `data` to the open paste; returns how many bytes of `data` it took. */
  function feedPaste(data: Buffer, out: Token[]): number {
    const open = paste!;
    const combined = Buffer.concat([open.carry, data]);
    const index = combined.indexOf(PASTE_END);
    if (index >= 0) {
      const content = Buffer.concat([...open.chunks, combined.subarray(0, index)]);
      out.push({ kind: 'paste', raw: Buffer.concat([open.start, content, PASTE_END]), data: content });
      paste = null;
      return index + PASTE_END.length - open.carry.length;
    }
    const keep = Math.max(0, combined.length - (PASTE_END.length - 1));
    open.chunks.push(Buffer.from(combined.subarray(0, keep)));
    open.carry = Buffer.from(combined.subarray(keep));
    return data.length;
  }

  function run(data: Buffer, final: boolean): Token[] {
    const out: Token[] = [];
    let at = 0;
    while (at < data.length) {
      if (paste) {
        at += feedPaste(data.subarray(at), out);
        continue;
      }
      const result = scan(data, at, final);
      if (!result) break;
      if (result.token === 'pasteStart') paste = { start: Buffer.from(data.subarray(at, result.end)), chunks: [], carry: Buffer.alloc(0) };
      else out.push(result.token);
      at = result.end;
    }
    pending = Buffer.from(data.subarray(at));
    return out;
  }

  function cancelTimer(): void {
    if (timer != null) timers.clear(timer);
    timer = null;
  }

  function flush(): Token[] {
    cancelTimer();
    return pending.length > 0 ? run(pending, true) : [];
  }

  return {
    push(chunk) {
      cancelTimer();
      const tokens = run(pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk, false);
      if (pending.length > 0) {
        timer = timers.set(() => {
          timer = null;
          const flushed = flush();
          if (flushed.length > 0) options.onFlush?.(flushed);
        }, escTimeoutMs);
      }
      return tokens;
    },
    flush,
  };
}

// ── Key names ────────────────────────────────────────────────────────────────

interface KeyDesc { key: string; ctrl: boolean; meta: boolean; shift: boolean }

const NAMED_ALIASES: Record<string, string> = {
  home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', ppage: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown', npage: 'PageDown',
  insert: 'Insert', ic: 'Insert', delete: 'Delete', dc: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  tab: 'Tab', btab: 'BTab', space: 'Space', enter: 'Enter', escape: 'Escape', bspace: 'BSpace',
};

/** `ESC [ n ~` key numbers (xterm, rxvt, the Linux console). */
const TILDE_KEYS: Record<string, string> = {
  1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End',
  11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5', 17: 'F6', 18: 'F7', 19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12',
};

/** Final-byte keys of `ESC [ … X` and `ESC O … X`. */
const LETTER_KEYS: Record<string, string> = {
  A: 'Up', B: 'Down', C: 'Right', D: 'Left', H: 'Home', F: 'End', P: 'F1', Q: 'F2', R: 'F3', S: 'F4', Z: 'BTab',
};

const LINUX_KEYS: Record<string, string> = { '[A': 'F1', '[B': 'F2', '[C': 'F3', '[D': 'F4', '[E': 'F5' };

const CONTROL_PUNCTUATION: Record<number, string> = { 0x1c: '\\', 0x1d: ']', 0x1e: '^', 0x1f: '_' };

const plain = (key: string): KeyDesc => ({ key, ctrl: false, meta: false, shift: false });

/** The xterm modifier parameter: 1 + (Shift 1, Alt 2, Ctrl 4, Meta 8); Alt and Meta both read as M-. */
function withModifier(key: string, param: string | undefined): KeyDesc | null {
  if (param == null || param === '') return plain(key);
  const value = Number(param) - 1;
  if (!Number.isInteger(value) || value < 0) return null;
  return { key, shift: (value & 1) !== 0, meta: (value & 10) !== 0, ctrl: (value & 4) !== 0 };
}

function decodeChar(text: string): KeyDesc | null {
  if (text.length === 0) return null;
  const code = text.charCodeAt(0);
  if (text.length === 1 && isControl(code)) {
    if (code === 0x00) return { ...plain('Space'), ctrl: true };
    if (code === 0x09) return plain('Tab');
    if (code === 0x0d) return plain('Enter');
    if (code === 0x1b) return plain('Escape');
    if (code === 0x7f) return plain('BSpace');
    if (code <= 0x1a) return { ...plain(String.fromCharCode(code + 0x60)), ctrl: true };
    return { ...plain(CONTROL_PUNCTUATION[code]), ctrl: true };
  }
  return plain(text === ' ' ? 'Space' : text);
}

function decodeToken(token: Token): KeyDesc | null {
  const desc = decodeUnprefixed(token);
  return desc && 'meta' in token && token.meta ? { ...desc, meta: true } : desc;
}

function decodeUnprefixed(token: Token): KeyDesc | null {
  switch (token.kind) {
    case 'control': return decodeChar(String.fromCharCode(token.code));
    case 'char': return decodeChar(token.text);
    case 'alt': {
      const inner = decodeChar(token.key);
      return inner && { ...inner, meta: true };
    }
    case 'csi': {
      if (token.intermediates !== '') return null;
      if (LINUX_KEYS[token.final] && token.params === '') return plain(LINUX_KEYS[token.final]);
      const [number, modifier, ...rest] = token.params.split(';');
      if (rest.length > 0) return null;
      if (LETTER_KEYS[token.final]) {
        if (number !== '' && number !== '1') return null;
        return withModifier(LETTER_KEYS[token.final], modifier);
      }
      const key = TILDE_KEYS[number];
      if (!key) return null;
      if (token.final === '~') return withModifier(key, modifier);
      if (modifier != null) return null;
      // rxvt: ^ Ctrl, $ Shift, @ Ctrl-Shift.
      if (token.final === '^') return { ...plain(key), ctrl: true };
      if (token.final === '$') return { ...plain(key), shift: true };
      if (token.final === '@') return { ...plain(key), ctrl: true, shift: true };
      return null;
    }
    case 'ss3': {
      const key = LETTER_KEYS[token.final];
      if (!key || key === 'BTab') return null;
      // Some terminals put the modifier in SS3 too: ESC O 5 P or ESC O 1 ; 5 P.
      const parts = token.params.split(';');
      if (parts.length > 2 || (parts.length === 2 && parts[0] !== '1')) return null;
      return withModifier(key, parts.at(-1));
    }
    default: return null;
  }
}

/** A tmux key name as a descriptor; C-i, C-m, C-[ and C-@ read as the keys their control bytes are. */
function parseKeyName(name: string): KeyDesc | null {
  if (!isTmuxKeyName(name)) return null;
  const desc = plain('');
  let base = name;
  for (let match = /^([CMS])-(?=.)/.exec(base); match; match = /^([CMS])-(?=.)/.exec(base)) {
    if (match[1] === 'C') desc.ctrl = true;
    else if (match[1] === 'M') desc.meta = true;
    else desc.shift = true;
    base = base.slice(2);
  }
  // isTmuxKeyName leaves a function key, a named key or one printable character.
  if (/^F([1-9]|1[0-2])$/i.test(base)) desc.key = base.toUpperCase();
  else desc.key = base.length > 1 ? NAMED_ALIASES[base.toLowerCase()] : base;
  if (desc.ctrl && desc.key.length === 1) {
    const lower = desc.key.toLowerCase();
    const asKey: Record<string, string> = { i: 'Tab', m: 'Enter', '[': 'Escape', '@': 'Space' };
    if (asKey[lower]) return { ...desc, ctrl: lower === '@', key: asKey[lower] };
    desc.key = lower;
  }
  return desc;
}

const descId = (desc: KeyDesc) => `${desc.ctrl ? 'C-' : ''}${desc.meta ? 'M-' : ''}${desc.shift ? 'S-' : ''}${desc.key}`;

/**
 * Matches tokens against tmux key names (`F12`, `C-a`, `M-1`, `C-S-F5`, `Up`, …;
 * see `isTmuxKeyName`): returns the first of `names` the token is, or null.
 * Recognises the xterm, rxvt and Linux console forms of function and cursor
 * keys, `C-x` as its control byte and `M-x` as ESC x. Invalid names never match.
 */
export function keyMatcher(names: string[]): (token: Token) => string | null {
  const byId = new Map<string, string>();
  for (const name of names) {
    const desc = parseKeyName(name);
    if (desc && !byId.has(descId(desc))) byId.set(descId(desc), name);
  }
  return (token) => {
    const desc = decodeToken(token);
    return desc ? byId.get(descId(desc)) ?? null : null;
  };
}
