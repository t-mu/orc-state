const FIRST_WORDS: readonly string[] = [
  'amber', 'azure', 'brass', 'bright', 'calm', 'cedar', 'cobalt', 'coral',
  'crisp', 'dawn', 'dense', 'dry', 'dusk', 'eager', 'fair', 'fast',
  'fleet', 'fresh', 'frost', 'glad', 'gold', 'gray', 'green', 'hollow',
  'jade', 'keen', 'large', 'light', 'lime', 'lofty', 'long', 'lunar',
  'mild', 'misty', 'near', 'noble', 'odd', 'pine', 'plain', 'plum',
  'pure', 'quick', 'quiet', 'rare', 'rich', 'rose', 'royal', 'sage',
  'sandy', 'sharp', 'silk', 'slate', 'slim', 'slow', 'small', 'smooth',
  'soft', 'solar', 'solid', 'spare', 'stark', 'steel', 'swift', 'tall',
];

const SECOND_WORDS: readonly string[] = [
  'anchor', 'anvil', 'arch', 'arrow', 'axle', 'basin', 'beam', 'bell',
  'blade', 'bolt', 'bone', 'brook', 'broom', 'brush', 'bucket', 'cable',
  'chain', 'cliff', 'clock', 'cloud', 'coil', 'crane', 'creek', 'crest',
  'crypt', 'dome', 'draft', 'drum', 'dust', 'flint', 'forge', 'gate',
  'glade', 'grain', 'grid', 'grove', 'hinge', 'hull', 'kettle', 'key',
  'lamp', 'latch', 'ledge', 'lodge', 'loom', 'mast', 'mill', 'moat',
  'mold', 'moss', 'oak', 'oar', 'orb', 'peak', 'pier', 'rock',
  'plow', 'pod', 'post', 'rail', 'reed', 'ridge', 'ring', 'rung',
];

/**
 * Return the first two-word name not present in `inUse`, using a deterministic
 * search order over fixed local word lists. Throws only if the pool (4096 names)
 * is fully exhausted.
 */
export function nextAvailableAgentName(inUse: ReadonlySet<string>): string {
  for (const first of FIRST_WORDS) {
    for (const second of SECOND_WORDS) {
      const candidate = `${first}-${second}`;
      if (!inUse.has(candidate)) return candidate;
    }
  }
  throw new Error('exhausted agent name pool');
}
