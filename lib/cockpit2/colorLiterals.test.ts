import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The files that may spell a colour: the theme, the screen model, the renderer and colour depth. */
const ALLOWED = new Set(['theme.ts', 'screen.ts', 'render.ts', 'color.ts']);
/** A palette or rgb `Color` literal, or a `#rrggbb` string. */
const COLOR_LITERAL = /type:\s*['"](?:palette|rgb)['"]|#[0-9a-f]{6}\b/i;

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

  it('appear only in theme.ts, screen.ts, render.ts and color.ts: widgets draw through theme roles', () => {
    const dir = import.meta.dirname;
    const offenders = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !ALLOWED.has(name))
      .flatMap((name) => colorLiteralLines(readFileSync(join(dir, name), 'utf8')).map((line) => `${name}:${line}`));
    expect(offenders).toEqual([]);
  });
});
