import { describe, it, expect } from 'vitest';
import { nextAvailableAgentName } from './agentNames.ts';

// Produce a deterministic RNG that yields the supplied sequence of values and
// cycles when exhausted. Each call to the picker consumes two values.
function stubRng(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

// Build a Set containing every name in the full FIRST x SECOND combination
// space by driving the picker with bucket-center seeds on an empty inUse set.
// `(i + 0.5) / N` aims at the midpoint of each bucket, which is robust against
// floating-point rounding that affects the `i / N` boundary.
function enumerateFullPool(): Set<string> {
  const FIRST_LEN = 72;
  const SECOND_LEN = 88;
  const full = new Set<string>();
  for (let i = 0; i < FIRST_LEN; i++) {
    for (let j = 0; j < SECOND_LEN; j++) {
      const rng = stubRng([(i + 0.5) / FIRST_LEN, (j + 0.5) / SECOND_LEN]);
      full.add(nextAvailableAgentName(new Set(), rng));
    }
  }
  return full;
}

describe('nextAvailableAgentName', () => {
  it('returns a random orc-themed name in <first>-<second> form', () => {
    const name = nextAvailableAgentName(new Set());
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    const [first, second] = name.split('-');
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it('returns a deterministic name when given a seeded RNG', () => {
    // The picker calls rng() twice per attempt: first selects FIRST_WORDS[i],
    // then SECOND_WORDS[j]. With [0, 0] we land on the alphabetically-first
    // entry of each list: 'ashen' and 'arrow'.
    const rng = stubRng([0, 0]);
    expect(nextAvailableAgentName(new Set(), rng)).toBe('ashen-arrow');
  });

  it('handles rng() returning exactly 1 without picking an out-of-range index', () => {
    // rng() === 1 must be clamped — otherwise Math.floor(1 * N) === N, which
    // would index past the end of the word list.
    const rng = stubRng([1, 1]);
    const name = nextAvailableAgentName(new Set(), rng);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    const [first, second] = name.split('-');
    // The clamp pushes indices to the last valid slot of each list.
    expect(first).toBe('wretched');
    expect(second).toBe('worm');
  });

  it('retries on collision and returns a name not in inUse', () => {
    // First two values pick ashen-arrow, which collides; next two pick a
    // different combination (ashen-ash) that is free.
    //              attempt 1      attempt 2
    const rng = stubRng([0, 0, 0, 1 / 88]);
    const inUse = new Set(['ashen-arrow']);
    const name = nextAvailableAgentName(inUse, rng);
    expect(name).toBe('ashen-ash');
    expect(inUse.has(name)).toBe(false);
  });

  it('falls back to scan when retries exhaust and still returns a free name', () => {
    // Block every name except the last slot in the deterministic scan order
    // (wretched-worm). Feed the picker an rng that always picks 'ashen-arrow',
    // which IS in use — this forces the hot-path retry cap to trip and hand
    // off to the scan fallback.
    const full = enumerateFullPool();
    const onlyLastFree = new Set(full);
    const theLastOne = 'wretched-worm';
    onlyLastFree.delete(theLastOne);

    const collidingRng = stubRng([0, 0]);
    const name = nextAvailableAgentName(onlyLastFree, collidingRng);
    expect(name).toBe(theLastOne);
  });

  it('throws when the pool is fully exhausted', () => {
    const full = enumerateFullPool();
    expect(full.size).toBe(72 * 88);

    expect(() => nextAvailableAgentName(full)).toThrow('exhausted agent name pool');
  });

  it('includes plausible orc-themed names in the combination space', () => {
    // Spot-check that specific combinations advertised in documentation exist.
    // Drive the picker with rng values biased to each target pair and confirm.
    const cases = [
      { first: 'broken', second: 'nose' },
      { first: 'slithering', second: 'arrow' },
      { first: 'iron', second: 'fang' },
      { first: 'reeking', second: 'bog' },
    ];
    const pool = enumerateFullPool();
    for (const { first, second } of cases) {
      expect(pool, `expected ${first}-${second} in the pool`)
        .toContain(`${first}-${second}`);
    }
  });
});
