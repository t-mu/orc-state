import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The files that may spell a colour: the theme, the screen model, the renderer and colour depth. */
const ALLOWED = new Set(['theme.ts', 'screen.ts', 'render.ts', 'color.ts']);
/**
 * A palette or rgb `Color` literal, a `#rrggbb` string, or a raw SGR colour:
 * an escape ending in a 16-colour code (`\x1b[31m`, `\u001b[1;44m`) or an
 * extended colour (`38;5;…`, `48;2;…`).
 */
const COLOR_LITERAL = /type:\s*['"](?:palette|rgb)['"]|#[0-9a-f]{6}\b|(?:\\x1b|\\u001b|\\e)\[(?:[0-9]*;)*(?:3[0-79]|4[0-79]|9[0-7]|10[0-7])m|\b[34]8;[25];/i;

/** The lines of `text` holding a colour literal, as `<line>: <text>`. */
function colorLiteralLines(text: string): string[] {
  return text.split('\n').flatMap((line, index) => (COLOR_LITERAL.test(line) ? [`${index + 1}: ${line.trim()}`] : []));
}

describe('colour literals in lib/cockpit2', () => {
  it('finds palette, rgb and #rrggbb literals', () => {
    expect(colorLiteralLines("const a = { type: 'palette', index: 3 };\nconst b = 1;\nconst c = { type: \"rgb\", r: 0, g: 0, b: 0 };\nconst d = '#FFB000';")).toEqual([
      "1: const a = { type: 'palette', index: 3 };",
      '3: const c = { type: "rgb", r: 0, g: 0, b: 0 };',
      "4: const d = '#FFB000';",
    ]);
    expect(colorLiteralLines("const ok = { type: 'default' };")).toEqual([]);
  });

  it('finds raw SGR colour escapes, not other escapes', () => {
    expect(colorLiteralLines(String.raw`const a = '\x1b[31m';
const b = '\u001b[1;44m';
const c = '\x1b[38;5;214m';
const d = CSI + '48;2;0;0;0m';
const e = '\x1b[0m\x1b[1m\x1b[?1049h\x1b[2J';`)).toEqual([
      "1: const a = '\\x1b[31m';",
      "2: const b = '\\u001b[1;44m';",
      "3: const c = '\\x1b[38;5;214m';",
      "4: const d = CSI + '48;2;0;0;0m';",
    ]);
  });

  it('appear only in theme.ts, screen.ts, render.ts and color.ts: widgets draw through theme roles', () => {
    const dir = import.meta.dirname;
    const offenders = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !ALLOWED.has(name))
      .flatMap((name) => colorLiteralLines(readFileSync(join(dir, name), 'utf8')).map((line) => `${name}:${line}`));
    expect(offenders).toEqual([]);
  });
});
