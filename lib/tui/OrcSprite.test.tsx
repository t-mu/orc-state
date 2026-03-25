import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { OrcSprite } from './OrcSprite.tsx';
import type { SpriteMap } from './sprites.ts';

const sprites: SpriteMap = new Map([
  ['idle', ['IDLE-1', 'IDLE-2']],
  ['work', ['WORK-1', 'WORK-2']],
  ['done', ['DONE-1']],
  ['fail', ['FAIL-1']],
]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OrcSprite', () => {
  it('cycles through sprite frames on a 500ms interval', async () => {
    const sprite = render(<OrcSprite spriteState="work" sprites={sprites} />);

    expect(sprite.lastFrame()).toContain('WORK-1');

    await vi.advanceTimersByTimeAsync(500);
    expect(sprite.lastFrame()).toContain('WORK-2');

    await vi.advanceTimersByTimeAsync(500);
    expect(sprite.lastFrame()).toContain('WORK-1');
  });
});
