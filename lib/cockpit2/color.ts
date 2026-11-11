/**
 * lib/cockpit2/color.ts — how many colours the outer terminal shows, and the
 * xterm-256 colour nearest an RGB one for a terminal without true colour.
 * Import-free, so the CLI layer can use it.
 */

/** `truecolor`: RGB colours are written as is; `256`: as the nearest xterm-256 index. */
export type ColorDepth = 'truecolor' | '256';

/** Whether `COLORTERM` announces 24-bit colour. */
export function terminalHasTrueColor(env: Record<string, string | undefined>): boolean {
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '');
}

/** The colour depth `env` announces: true colour only when `COLORTERM` says so (as `terminalHasTrueColor`). */
export function colorDepthFromEnv(env: Record<string, string | undefined>): ColorDepth {
  return terminalHasTrueColor(env) ? 'truecolor' : '256';
}

/** The channel values of the xterm 6x6x6 cube (indices 16-231). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const nearestCubeLevel = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));

const distance = (r: number, g: number, b: number, r2: number, g2: number, b2: number) => (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;

/** The xterm-256 index (16-255) nearest `r`, `g`, `b`: the closer of the 6x6x6 cube and the grey ramp (the cube on a tie). */
export function nearestXterm256(r: number, g: number, b: number): number {
  const [ri, gi, bi] = [nearestCubeLevel(r), nearestCubeLevel(g), nearestCubeLevel(b)];
  const cubeDistance = distance(r, g, b, CUBE_LEVELS[ri], CUBE_LEVELS[gi], CUBE_LEVELS[bi]);
  // The grey ramp (232-255) runs from 8 to 238 in steps of 10.
  const greyStep = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const grey = 8 + greyStep * 10;
  const greyDistance = distance(r, g, b, grey, grey, grey);
  return greyDistance < cubeDistance ? 232 + greyStep : 16 + 36 * ri + 6 * gi + bi;
}
