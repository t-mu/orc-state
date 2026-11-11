import { describe, expect, it } from 'vitest';
import { cockpit2Paths } from './cockpit2.ts';

describe('cockpit2Paths', () => {
  it('keeps the cockpit lock and the view state under orc\'s data home', () => {
    expect(cockpit2Paths('/home/u/.local/share/orc-state')).toEqual({
      lockPath: '/home/u/.local/share/orc-state/cockpit/cockpit2.lock',
      viewStatePath: '/home/u/.local/share/orc-state/cockpit/view-state.json',
      viewStateLockPath: '/home/u/.local/share/orc-state/cockpit/view-state.lock',
    });
  });
});
