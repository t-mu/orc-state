import { describe, expect, it } from 'vitest';
import { terminalHasTrueColor as adapterHasTrueColor } from '../../adapters/tmuxCockpit.ts';
import { colorDepthFromEnv, nearestXterm256, terminalHasTrueColor } from './color.ts';

describe('nearestXterm256', () => {
  it('maps pure colours to their cube corners', () => {
    expect(nearestXterm256(255, 0, 0)).toBe(196);
    expect(nearestXterm256(0, 255, 0)).toBe(46);
    expect(nearestXterm256(0, 0, 255)).toBe(21);
    expect(nearestXterm256(255, 255, 0)).toBe(226);
    expect(nearestXterm256(0, 255, 255)).toBe(51);
    expect(nearestXterm256(255, 0, 255)).toBe(201);
  });

  it('maps the edges 0 and 255 to the cube, black and white', () => {
    expect(nearestXterm256(0, 0, 0)).toBe(16);
    expect(nearestXterm256(255, 255, 255)).toBe(231);
  });

  it('maps greys to the grey ramp when it is closer, else to the cube', () => {
    expect(nearestXterm256(8, 8, 8)).toBe(232);
    expect(nearestXterm256(128, 128, 128)).toBe(244);
    expect(nearestXterm256(238, 238, 238)).toBe(255);
    expect(nearestXterm256(245, 245, 245)).toBe(255);
    expect(nearestXterm256(250, 250, 250)).toBe(231); // 255 (cube white) is nearer than 238
    expect(nearestXterm256(3, 3, 3)).toBe(16); // 0 (cube black) is nearer than 8
    expect(nearestXterm256(95, 95, 95)).toBe(59); // exact on the cube
  });

  it('maps colours between cube levels to the nearest level', () => {
    // Blue at 255 keeps the grey ramp out of reach, so only the red level changes.
    expect(nearestXterm256(47, 0, 255)).toBe(21);
    expect(nearestXterm256(48, 0, 255)).toBe(57);
    expect(nearestXterm256(114, 0, 255)).toBe(57);
    expect(nearestXterm256(115, 0, 255)).toBe(93);
    expect(nearestXterm256(234, 0, 255)).toBe(165);
    expect(nearestXterm256(235, 0, 255)).toBe(201);
  });

  it('prefers the grey ramp for a dark colour nearer a grey than a cube colour', () => {
    expect(nearestXterm256(47, 0, 0)).toBe(233);
    expect(nearestXterm256(20, 20, 20)).toBe(233);
  });
});

describe('colour depth from the environment', () => {
  const cases: Array<[string | undefined, boolean]> = [['truecolor', true], ['24bit', true], ['TrueColor', true], ['256', false], ['', false], [undefined, false]];

  it.each(cases)('COLORTERM=%s → true colour %s, as the old cockpit decides', (value, expected) => {
    const env = value === undefined ? {} : { COLORTERM: value };
    expect(terminalHasTrueColor(env)).toBe(expected);
    expect(adapterHasTrueColor(env)).toBe(expected);
    expect(colorDepthFromEnv(env)).toBe(expected ? 'truecolor' : '256');
  });
});
