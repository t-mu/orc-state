import { describe, expect, it } from 'vitest';
import { cockpit2Paths } from './cockpit2.ts';

describe('cockpit2Paths', () => {
  it('keeps the cockpit lock under orc\'s data home', () => {
    expect(cockpit2Paths('/home/u/.local/share/orc-state')).toEqual({
      dataHome: '/home/u/.local/share/orc-state',
      lockPath: '/home/u/.local/share/orc-state/cockpit/cockpit2.lock',
    });
  });
});
