const FIRST_WORDS: readonly string[] = [
  'ashen', 'battered', 'bellowing', 'bitter', 'black', 'bloody', 'broken', 'brutal',
  'burly', 'charred', 'chipped', 'cleaving', 'cracked', 'creeping', 'cruel', 'crushing',
  'dented', 'dire', 'dusky', 'feral', 'fierce', 'filthy', 'foul', 'gnarled',
  'gnashing', 'grim', 'grimy', 'grinding', 'grisly', 'gruff', 'howling', 'hulking',
  'hunting', 'iron', 'jagged', 'looming', 'lumbering', 'lurking', 'mangled', 'mighty',
  'murky', 'notched', 'ochre', 'pallid', 'pitch', 'prowling', 'ragged', 'raging',
  'raiding', 'rampaging', 'rank', 'reeking', 'roaring', 'ruddy', 'rust', 'sallow',
  'savage', 'scarred', 'shattered', 'slithering', 'smoldering', 'snarling', 'sooty', 'splintered',
  'stalking', 'stomping', 'surly', 'tar', 'twisted', 'vile', 'wicked', 'wretched',
];

const SECOND_WORDS: readonly string[] = [
  'arrow', 'ash', 'axe', 'banner', 'bat', 'beetle', 'blade', 'boar',
  'bog', 'bone', 'brand', 'brazier', 'cage', 'cairn', 'cauldron', 'cave',
  'chain', 'claw', 'cleaver', 'club', 'coal', 'collar', 'crag', 'crow',
  'cudgel', 'dagger', 'dirk', 'ember', 'fang', 'fen', 'fist', 'flail',
  'gauntlet', 'gorge', 'grave', 'gullet', 'hammer', 'hatchet', 'helm', 'hide',
  'hoof', 'hook', 'horn', 'hyena', 'jaw', 'kettle', 'knuckle', 'mace',
  'maul', 'maw', 'mire', 'mold', 'moor', 'mud', 'nose', 'pike',
  'pit', 'pyre', 'rat', 'raven', 'ravine', 'rope', 'rot', 'rubble',
  'scar', 'serpent', 'shard', 'shield', 'skull', 'slug', 'smoke', 'snout',
  'spear', 'spider', 'spike', 'spine', 'stake', 'swamp', 'throat', 'toad',
  'tomb', 'tongue', 'tooth', 'torch', 'tusk', 'vulture', 'wolf', 'worm',
];

/**
 * Return a random orc-themed `<first>-<second>` name not present in `inUse`.
 * Retries a bounded number of times on collision, then falls back to a
 * deterministic scan of the remaining pool. Throws only when the pool
 * (|FIRST_WORDS| x |SECOND_WORDS|) is fully exhausted.
 *
 * `rng` defaults to `Math.random` and must return a value in [0, 1). Values
 * equal to 1 are clamped so `Math.floor(rng() * N) < N` holds. The picker
 * calls `rng()` twice per retry in fixed order: first for `FIRST_WORDS`,
 * then for `SECOND_WORDS`.
 */
export function nextAvailableAgentName(
  inUse: ReadonlySet<string>,
  rng: () => number = Math.random,
): string {
  const pickIndex = (n: number) => {
    const r = rng();
    const clamped = r >= 1 ? 0.9999999999 : r < 0 ? 0 : r;
    return Math.floor(clamped * n);
  };

  const retryCap = Math.min(FIRST_WORDS.length * SECOND_WORDS.length, 1024);
  for (let i = 0; i < retryCap; i++) {
    const first = FIRST_WORDS[pickIndex(FIRST_WORDS.length)];
    const second = SECOND_WORDS[pickIndex(SECOND_WORDS.length)];
    const candidate = `${first}-${second}`;
    if (!inUse.has(candidate)) return candidate;
  }

  for (const first of FIRST_WORDS) {
    for (const second of SECOND_WORDS) {
      const candidate = `${first}-${second}`;
      if (!inUse.has(candidate)) return candidate;
    }
  }

  throw new Error('exhausted agent name pool');
}
