import { describe, expect, it } from 'vitest';
import { preloadSprites, renderSpriteMap } from './sprites.ts';

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

describe('preloadSprites', () => {
  it('loads base and scout sprite keys with deterministic frame ordering', async () => {
    const spriteMap = await preloadSprites();

    expect(Array.from(spriteMap.keys())).toEqual([
      'idle',
      'work',
      'done',
      'fail',
      'scout:idle',
      'scout:work',
      'scout:done',
      'scout:fail',
    ]);
    expect(spriteMap.get('idle')).toHaveLength(2);
    expect(spriteMap.get('work')).toHaveLength(3);
    expect(spriteMap.get('done')).toHaveLength(2);
    expect(spriteMap.get('fail')).toHaveLength(1);
    expect(spriteMap.get('scout:idle')).toHaveLength(2);
    expect(spriteMap.get('scout:work')).toHaveLength(3);
    expect(spriteMap.get('scout:done')).toHaveLength(2);
    expect(spriteMap.get('scout:fail')).toHaveLength(1);
  });

  it('caches the rendered sprite map after the first load', async () => {
    const firstLoad = await preloadSprites();
    const secondLoad = await preloadSprites();

    expect(secondLoad).toBe(firstLoad);
  });

  it('renders non-empty multiline strings', async () => {
    const spriteMap = await preloadSprites();

    for (const frames of spriteMap.values()) {
      for (const frame of frames) {
        expect(typeof frame).toBe('string');
        expect(frame.length).toBeGreaterThan(0);
        expect(frame.split('\n').length).toBeGreaterThan(1);
      }
    }
  });

  it('fails clearly on an unknown palette token', () => {
    expect(() =>
      renderSpriteMap({
        idle: [['Z']],
        work: [['G']],
        done: [['G']],
        fail: [['R']],
      }),
    ).toThrow(/Unknown sprite palette token "Z" in idle frame 1 row 1/);
  });

  it('preserves readable frame structure after ANSI stripping', async () => {
    const spriteMap = await preloadSprites();
    const firstIdle = spriteMap.get('idle')?.[0] ?? '';

    const plain = firstIdle.replaceAll(ANSI_PATTERN, '');

    expect(plain.split('\n')).toHaveLength(8);
    expect(plain).toContain('█');
  });

  it('renders scout frames differently from worker frames', async () => {
    const spriteMap = await preloadSprites();

    expect(spriteMap.get('scout:idle')?.[0]).not.toBe(spriteMap.get('idle')?.[0]);
    expect(spriteMap.get('scout:work')?.[0]).not.toBe(spriteMap.get('work')?.[0]);
  });
});
