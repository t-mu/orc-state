import { describe, expect, it } from 'vitest';
import { createTokenizer, keyMatcher, type Token, type TokenizerTimers } from './input.ts';

const bytes = (text: string) => Buffer.from(text, 'latin1');
const utf8 = (text: string) => Buffer.from(text, 'utf8');

/** A manual timer: `fire()` runs the pending callback. */
function manualTimers(): TokenizerTimers & { fire(): void; pending(): boolean; lastMs: number | null } {
  let callback: (() => void) | null = null;
  return {
    lastMs: null,
    set(fn, ms) { callback = fn; this.lastMs = ms; return fn; },
    clear() { callback = null; },
    fire() { const fn = callback; callback = null; fn?.(); },
    pending: () => callback != null,
  };
}

function tokenize(...chunks: Buffer[]): { tokens: Token[]; flushed: Token[] } {
  const flushed: Token[] = [];
  const timers = manualTimers();
  const tokenizer = createTokenizer({ timers, onFlush: (tokens) => flushed.push(...tokens) });
  const tokens = chunks.flatMap((chunk) => tokenizer.push(chunk));
  return { tokens, flushed };
}

/** The kind and raw bytes of each token, the shape most tests compare. */
const shape = (tokens: Token[]) => tokens.map((token) => [token.kind, token.raw.toString('latin1')]);

describe('createTokenizer', () => {
  it('emits every token kind with its fields and raw bytes', () => {
    const input = Buffer.concat([
      bytes('a\x01\x1b[1;5A\x1bOP\x1bx\x1b[<0;3;4M'),
      utf8('é'),
      bytes('\x1b[200~hi\x1b[A\x1b[201~'),
    ]);
    const { tokens } = tokenize(input);
    expect(tokens).toEqual([
      { kind: 'char', raw: bytes('a'), text: 'a' },
      { kind: 'control', raw: bytes('\x01'), code: 1 },
      { kind: 'csi', raw: bytes('\x1b[1;5A'), params: '1;5', intermediates: '', final: 'A' },
      { kind: 'ss3', raw: bytes('\x1bOP'), params: '', final: 'P' },
      { kind: 'alt', raw: bytes('\x1bx'), key: 'x' },
      { kind: 'mouse', raw: bytes('\x1b[<0;3;4M') },
      { kind: 'char', raw: utf8('é'), text: 'é' },
      { kind: 'paste', raw: bytes('\x1b[200~hi\x1b[A\x1b[201~'), data: bytes('hi\x1b[A') },
    ]);
    expect(Buffer.concat(tokens.map((token) => token.raw))).toEqual(input);
  });

  it('reads several keys from one read', () => {
    expect(shape(tokenize(bytes('ab\x1b[15~\x1b[[A\r\x7f')).tokens)).toEqual([
      ['char', 'a'], ['char', 'b'], ['csi', '\x1b[15~'], ['csi', '\x1b[[A'], ['control', '\r'], ['control', '\x7f'],
    ]);
  });

  it.each([
    ['a CSI sequence', bytes('\x1b[15;5~')],
    ['an SS3 sequence', bytes('\x1bOP')],
    ['a mouse report', bytes('\x1b[<35;120;40M')],
    ['a Linux console key', bytes('\x1b[[C')],
    ['an rxvt Meta function key', bytes('\x1b\x1b[11^')],
    ['an Alt key', utf8('\x1bä')],
    ['a UTF-8 character', utf8('😀')],
    ['a bracketed paste', Buffer.concat([bytes('\x1b[200~'), utf8('pä\x1b[201'), bytes('~')])],
  ])('keeps %s whole when it is split at any byte', (_label, input) => {
    const whole = tokenize(input).tokens;
    expect(whole).toHaveLength(1);
    for (let split = 1; split < input.length; split += 1) {
      const { tokens, flushed } = tokenize(input.subarray(0, split), input.subarray(split));
      expect(tokens, `split at ${split}`).toEqual(whole);
      expect(flushed).toEqual([]);
    }
  });

  it('keeps a paste open across many reads and ignores the timeout inside it', () => {
    const timers = manualTimers();
    const tokenizer = createTokenizer({ timers });
    expect(tokenizer.push(bytes('\x1b[200~one '))).toEqual([]);
    expect(timers.pending()).toBe(false);
    expect(tokenizer.push(bytes('\x1b two \x1b['))).toEqual([]);
    expect(tokenizer.flush()).toEqual([]);
    expect(tokenizer.push(bytes('20'))).toEqual([]);
    const tokens = tokenizer.push(bytes('1~x'));
    expect(tokens).toEqual([
      { kind: 'paste', raw: bytes('\x1b[200~one \x1b two \x1b[201~'), data: bytes('one \x1b two ') },
      { kind: 'char', raw: bytes('x'), text: 'x' },
    ]);
  });

  it('flushes a lone ESC as a key after the timeout', () => {
    const timers = manualTimers();
    const flushed: Token[] = [];
    const tokenizer = createTokenizer({ timers, escTimeoutMs: 40, onFlush: (tokens) => flushed.push(...tokens) });
    expect(tokenizer.push(bytes('a\x1b'))).toEqual([{ kind: 'char', raw: bytes('a'), text: 'a' }]);
    expect(timers.lastMs).toBe(40);
    timers.fire();
    expect(flushed).toEqual([{ kind: 'control', raw: bytes('\x1b'), code: 0x1b }]);
    expect(tokenizer.push(bytes('b'))).toEqual([{ kind: 'char', raw: bytes('b'), text: 'b' }]);
  });

  it('defaults the timeout to 25 ms', () => {
    const timers = manualTimers();
    createTokenizer({ timers }).push(bytes('\x1b'));
    expect(timers.lastMs).toBe(25);
  });

  it('joins an ESC and a quickly following [A into one CSI token', () => {
    const timers = manualTimers();
    const tokenizer = createTokenizer({ timers });
    expect(tokenizer.push(bytes('\x1b'))).toEqual([]);
    expect(timers.pending()).toBe(true);
    expect(tokenizer.push(bytes('[A'))).toEqual([{ kind: 'csi', raw: bytes('\x1b[A'), params: '', intermediates: '', final: 'A' }]);
    expect(timers.pending()).toBe(false);
  });

  it('reads ESC [ and ESC O cut short by the timeout as Alt keys, ESC ESC as Escape then the rest unless a sequence follows', () => {
    const tokenizer = createTokenizer({ timers: manualTimers() });
    tokenizer.push(bytes('\x1b['));
    expect(shape(tokenizer.flush())).toEqual([['alt', '\x1b[']]);
    tokenizer.push(bytes('\x1bO'));
    expect(shape(tokenizer.flush())).toEqual([['alt', '\x1bO']]);
    expect(shape(tokenizer.push(bytes('\x1b\x1bx')))).toEqual([['control', '\x1b'], ['alt', '\x1bx']]);
    expect(tokenizer.push(bytes('\x1b\x1b'))).toEqual([]);
    expect(shape(tokenizer.flush())).toEqual([['control', '\x1b'], ['control', '\x1b']]);
    expect(tokenizer.push(bytes('\x1b\x1bOP'))).toEqual([{ kind: 'ss3', raw: bytes('\x1b\x1bOP'), params: '', final: 'P', meta: true }]);
  });

  it('ends an rxvt Shift-function key at its $', () => {
    expect(tokenize(bytes('\x1b[24$\x1b[23$')).tokens).toEqual([
      { kind: 'csi', raw: bytes('\x1b[24$'), params: '24', intermediates: '', final: '$' },
      { kind: 'csi', raw: bytes('\x1b[23$'), params: '23', intermediates: '', final: '$' },
    ]);
    // Its `$` is final even when the read ends there: a reply with an intermediate `$` has several parameters.
    expect(shape(tokenize(bytes('\x1b[24$')).tokens)).toEqual([['csi', '\x1b[24$']]);
    expect(shape(tokenize(bytes('\x1b[24$a\x1b[3$')).tokens)).toEqual([['csi', '\x1b[24$'], ['char', 'a'], ['csi', '\x1b[3$']]);
    expect(tokenize(bytes('\x1b[?1;2$y')).tokens).toEqual([{ kind: 'csi', raw: bytes('\x1b[?1;2$y'), params: '?1;2', intermediates: '$', final: 'y' }]);
  });

  it('turns invalid UTF-8 into replacement characters, keeping the raw bytes', () => {
    const { tokens } = tokenize(Buffer.from([0xff, 0xc3, 0x41]));
    expect(tokens).toEqual([
      { kind: 'char', raw: Buffer.from([0xff]), text: '�' },
      { kind: 'char', raw: Buffer.from([0xc3]), text: '�' },
      { kind: 'char', raw: bytes('A'), text: 'A' },
    ]);
  });

  it('flushes an incomplete UTF-8 character after the timeout', () => {
    const tokenizer = createTokenizer({ timers: manualTimers() });
    expect(tokenizer.push(Buffer.from([0xe2, 0x82]))).toEqual([]);
    expect(tokenizer.flush()).toEqual([{ kind: 'char', raw: Buffer.from([0xe2, 0x82]), text: '�' }]);
  });
});

describe('keyMatcher', () => {
  const tokens = (text: string) => tokenize(bytes(text)).tokens;
  const one = (text: string) => {
    const [token, ...rest] = tokens(text);
    expect(rest).toEqual([]);
    return token;
  };

  const F_KEYS = Array.from({ length: 12 }, (_, index) => `F${index + 1}`);
  const XTERM: Record<string, string> = {
    F1: 'P', F2: 'Q', F3: 'R', F4: 'S', F5: '15', F6: '17', F7: '18', F8: '19', F9: '20', F10: '21', F11: '23', F12: '24',
  };
  /** xterm's form of `key` with modifier parameter `mod` (1 for none). */
  const xterm = (key: string, mod: number) => {
    const code = XTERM[key];
    if (/^\d/.test(code)) return mod === 1 ? `\x1b[${code}~` : `\x1b[${code};${mod}~`;
    return mod === 1 ? `\x1bO${code}` : `\x1b[1;${mod}${code}`;
  };
  const RXVT: Record<string, string> = {
    F1: '11', F2: '12', F3: '13', F4: '14', F5: '15', F6: '17', F7: '18', F8: '19', F9: '20', F10: '21', F11: '23', F12: '24',
  };

  it('matches F1-F12 with and without modifiers in xterm forms', () => {
    for (const key of F_KEYS) {
      const forms: [string, number][] = [[key, 1], [`S-${key}`, 2], [`M-${key}`, 3], [`C-${key}`, 5], [`C-S-${key}`, 6], [`C-M-${key}`, 7]];
      const match = keyMatcher(forms.map(([name]) => name));
      for (const [name, mod] of forms) expect(match(one(xterm(key, mod))), `${name} as ${JSON.stringify(xterm(key, mod))}`).toBe(name);
    }
  });

  it('matches the xterm Meta modifier bit as M- and SS3 modifier forms', () => {
    expect(keyMatcher(['M-F5'])(one('\x1b[15;9~'))).toBe('M-F5');
    expect(keyMatcher(['C-F1'])(one('\x1bO5P'))).toBe('C-F1');
    expect(keyMatcher(['C-F1'])(one('\x1bO1;5P'))).toBe('C-F1');
    expect(keyMatcher(['F1'])(one('\x1b[P'))).toBe('F1');
  });

  it('matches F1-F12 with and without modifiers in rxvt forms', () => {
    for (const key of F_KEYS) {
      const match = keyMatcher([key, `C-${key}`, `S-${key}`, `C-S-${key}`]);
      expect(match(one(`\x1b[${RXVT[key]}~`))).toBe(key);
      expect(match(one(`\x1b[${RXVT[key]}^`))).toBe(`C-${key}`);
      expect(match(one(`\x1b[${RXVT[key]}$`))).toBe(`S-${key}`);
      expect(match(one(`\x1b[${RXVT[key]}@`))).toBe(`C-S-${key}`);
      const meta = keyMatcher([`M-${key}`, `C-M-${key}`, `M-S-${key}`, `C-M-S-${key}`]);
      expect(meta(one(`\x1b\x1b[${RXVT[key]}~`))).toBe(`M-${key}`);
      expect(meta(one(`\x1b\x1b[${RXVT[key]}^`))).toBe(`C-M-${key}`);
      expect(meta(one(`\x1b\x1b[${RXVT[key]}$`))).toBe(`M-S-${key}`);
      expect(meta(one(`\x1b\x1b[${RXVT[key]}@`))).toBe(`C-M-S-${key}`);
    }
  });

  it('matches F1-F12 in Linux console forms', () => {
    const LINUX: Record<string, string> = {
      F1: '\x1b[[A', F2: '\x1b[[B', F3: '\x1b[[C', F4: '\x1b[[D', F5: '\x1b[[E', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
      F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
    };
    const match = keyMatcher(F_KEYS);
    for (const key of F_KEYS) expect(match(one(LINUX[key])), key).toBe(key);
  });

  it('matches C- keys as control bytes and M- keys as ESC plus the key', () => {
    const match = keyMatcher(['C-a', 'M-1', 'C-]', 'C-M-b', 'C-Space', 'M-Enter']);
    expect(match(one('\x01'))).toBe('C-a');
    expect(match(one('\x1b1'))).toBe('M-1');
    expect(match(one('\x1d'))).toBe('C-]');
    expect(match(one('\x1b\x02'))).toBe('C-M-b');
    expect(match(one('\x00'))).toBe('C-Space');
    expect(match(one('\x1b\r'))).toBe('M-Enter');
    expect(keyMatcher(['M-Up'])(one('\x1b\x1b[A'))).toBe('M-Up');
    expect(keyMatcher(['C-A'])(one('\x01'))).toBe('C-A');
  });

  it('matches named keys, their aliases and plain characters', () => {
    const match = keyMatcher(['Up', 'C-Left', 'PgUp', 'DC', 'Home', 'BTab', 'Tab', 'Escape', 'BSpace', 'Space', '&', 'N', 'C-m']);
    expect(match(one('\x1b[A'))).toBe('Up');
    expect(match(one('\x1bOA'))).toBe('Up');
    expect(match(one('\x1b[1;5D'))).toBe('C-Left');
    expect(match(one('\x1b[5~'))).toBe('PgUp');
    expect(match(one('\x1b[3~'))).toBe('DC');
    expect(match(one('\x1b[H'))).toBe('Home');
    expect(match(one('\x1b[1~'))).toBe('Home');
    expect(match(one('\x1b[Z'))).toBe('BTab');
    expect(match(one('\t'))).toBe('Tab');
    expect(match(one('\x7f'))).toBe('BSpace');
    expect(match(one(' '))).toBe('Space');
    expect(match(one('&'))).toBe('&');
    expect(match(one('N'))).toBe('N');
    expect(match(one('\r'))).toBe('C-m');
    const flushed = createTokenizer({ timers: manualTimers() });
    flushed.push(bytes('\x1b'));
    expect(match(flushed.flush()[0])).toBe('Escape');
  });

  it('returns null for keys it was not given, other tokens and invalid names', () => {
    const match = keyMatcher(['F12', 'C-a', 'Ctrl-b', 'F13', '']);
    for (const text of ['n', 'A', '\x02', '\x1ba', '\x1b[24;5~', '\x1b[11^', '\x1b[[B', '\x1b[A', '\x1b[<0;1;1M', '\x1b[200~x\x1b[201~', '\x1b[99~', '\x1b[24;5;1~', '\x1b[?24~']) {
      expect(match(one(text)), JSON.stringify(text)).toBeNull();
    }
    expect(match(one('\x1b[24~'))).toBe('F12');
  });

  it('answers with the first of equivalent names', () => {
    expect(keyMatcher(['PageUp', 'PgUp'])(one('\x1b[5~'))).toBe('PageUp');
  });
});
