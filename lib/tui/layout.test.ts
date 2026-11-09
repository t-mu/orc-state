import { describe, expect, it } from 'vitest';
import { computeLayout, fitList, measureBlock, slotHeight, type LayoutInput } from './layout.ts';

function input(overrides: Partial<LayoutInput> = {}): LayoutInput {
  return {
    rows: 40,
    columns: 120,
    bannerLines: 8,
    bannerWidth: 55,
    spriteLines: 8,
    hasFailures: false,
    slots: [{ phaseLines: 6 }, { phaseLines: 6 }],
    scoutCount: 3,
    runCount: 2,
    eventCount: 30,
    hasEventError: false,
    ...overrides,
  };
}

describe('computeLayout', () => {
  it('does not budget when the terminal height is unknown', () => {
    const layout = computeLayout(input({ rows: undefined }));
    expect(layout).toEqual({
      showBanner: true,
      slotDetail: 'full',
      maxScoutLines: Infinity,
      maxRunLines: Infinity,
      maxEventLines: Infinity,
    });
  });

  it('keeps full detail and every item when the terminal is tall enough', () => {
    const layout = computeLayout(input({ rows: 200 }));
    expect(layout.showBanner).toBe(true);
    expect(layout.slotDetail).toBe('full');
    expect(layout.maxScoutLines).toBe(3);
    expect(layout.maxRunLines).toBe(2);
    expect(layout.maxEventLines).toBe(10);
  });

  it('drops the sprite before anything else on a 40-row terminal', () => {
    const layout = computeLayout(input());
    expect(layout.showBanner).toBe(true);
    expect(layout.slotDetail).toBe('compact');
  });

  it('degrades to minimal slots, then drops the banner, as rows shrink', () => {
    expect(computeLayout(input({ rows: 32 })).slotDetail).toBe('minimal');
    const tiny = computeLayout(input({ rows: 24 }));
    expect(tiny.slotDetail).toBe('minimal');
    expect(tiny.showBanner).toBe(false);
  });

  it('hides the banner when it is wider than the terminal', () => {
    expect(computeLayout(input({ rows: 200, columns: 40 })).showBanner).toBe(false);
  });

  it('gives spare rows to runs, then events, then scouts', () => {
    const layout = computeLayout(input({ rows: 50, runCount: 5, eventCount: 10, scoutCount: 10 }));
    expect(layout.maxRunLines).toBe(5);
    expect(layout.maxEventLines).toBeGreaterThan(1);
    expect(layout.maxScoutLines).toBeLessThan(10);
  });

  it('fits within rows - 1 for its own estimate', () => {
    const sizes = [[24, 80], [30, 80], [40, 60], [40, 80], [40, 120], [60, 60], [60, 200]];
    for (const [rows, columns] of sizes) {
      const params = input({ rows, columns });
      const layout = computeLayout(params);
      const perRow = Math.max(1, Math.floor(columns / 37));
      const rowsOfSlots = Math.ceil(params.slots.length / perRow);
      const header = (layout.showBanner ? params.bannerLines : 0) + 3;
      const grid = 2 + rowsOfSlots * (slotHeight(params.slots[0], layout.slotDetail, params.spriteLines) + 1);
      const lists = (2 + layout.maxScoutLines) + (2 + layout.maxRunLines) + (1 + layout.maxEventLines);
      expect(header + grid + lists).toBeLessThanOrEqual(rows - 1);
    }
  });
});

describe('computeLayout — waiting input', () => {
  it('budgets the header waiting line and the slot indicator rows', () => {
    const base = input({ rows: 52 });
    const waiting = input({ rows: 52, waitingCount: 1, slots: [{ phaseLines: 6, waitingLines: 2 }, { phaseLines: 6 }] });
    const lines = (l: ReturnType<typeof computeLayout>) => l.maxRunLines + l.maxEventLines + l.maxScoutLines;
    // One header line plus two slot rows (the tallest slot in the row sets its height).
    expect(lines(computeLayout(base)) - lines(computeLayout(waiting))).toBe(3);
  });
});

describe('slotHeight', () => {
  it('counts border, text lines, sprite and phases', () => {
    expect(slotHeight({ phaseLines: 6 }, 'full', 8)).toBe(21);
    expect(slotHeight({ phaseLines: 6 }, 'compact', 8)).toBe(13);
    expect(slotHeight({ phaseLines: 6 }, 'minimal', 8)).toBe(8);
  });

  it('adds the NEEDS INPUT rows at every detail', () => {
    expect(slotHeight({ phaseLines: 6, waitingLines: 2 }, 'full', 8)).toBe(23);
    expect(slotHeight({ phaseLines: 6, waitingLines: 2 }, 'minimal', 8)).toBe(10);
  });
});

describe('fitList', () => {
  it('shows everything that fits', () => {
    expect(fitList([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], hidden: 0 });
  });

  it('keeps one line for the hidden count', () => {
    expect(fitList([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2], hidden: 3 });
    expect(fitList([1, 2], 1)).toEqual({ shown: [], hidden: 2 });
  });
});

describe('measureBlock', () => {
  it('ignores colour codes when measuring width', () => {
    expect(measureBlock('\u001b[32mab\u001b[39m\ncde')).toEqual({ lines: 2, width: 3 });
  });
});
