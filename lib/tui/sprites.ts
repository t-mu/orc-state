import chalk from 'chalk';

export type SpriteState = 'idle' | 'work' | 'done' | 'fail';
export type SpriteRole = 'worker' | 'reviewer' | 'scout';
export type SpriteKey = SpriteState | `${SpriteRole}:${SpriteState}`;
export type SpriteMap = Map<SpriteKey, string[]>;

type PaletteToken = '.' | 'G' | 'K' | 'T' | 'D' | 'Y' | 'R' | 'C' | 'S';

const PALETTE: Readonly<Record<Exclude<PaletteToken, '.'>, string>> = {
  G: '#59b45d',
  K: '#1c1c1c',
  T: '#f0e2c0',
  D: '#6f5f4d',
  Y: '#d4af37',
  R: '#ff3b30',
  C: '#2d9c9c',
  S: '#c0cad4',
};

const FRAME_SETS: Readonly<Record<SpriteState, readonly string[][]>> = {
  idle: [
    [
      '....KKKK....',
      '...KGGGGK...',
      '..KGGTTGGK..',
      '..GGGGGGGG..',
      '..GGGGGGGG..',
      '...DDDDDD...',
      '..D......D..',
      '............',
    ],
    [
      '....KKKK....',
      '...KGGGGK...',
      '..KGG..GGK..',
      '..GGGGGGGG..',
      '..GGGGGGGG..',
      '...DDDDDD...',
      '..D......D..',
      '............',
    ],
  ],
  work: [
    [
      '....KKKK....',
      '...KGGGGK...',
      '..KGGTTGGK..',
      '..GGGGGGGG..',
      '...DYYYYD...',
      '..DDDDDDDD..',
      '..D......D..',
      '............',
    ],
    [
      '....KKKK....',
      '...KGGGGK...',
      '..KGGTTGGK..',
      '..GGGGGGGG..',
      '..DYYYYYYD..',
      '..DDDDDDDD..',
      '...D....D...',
      '............',
    ],
    [
      '....KKKK....',
      '...KGGGGK...',
      '..KGGTTGGK..',
      '..GGGGGGGG..',
      '.DYYYYYYYD..',
      '..DDDDDDDD..',
      '..D......D..',
      '............',
    ],
  ],
  done: [
    [
      '...K....K...',
      '..KGGGGGGK..',
      '..GGGTTGGG..',
      '..GGGGGGGG..',
      '...GGGGGG...',
      '..DYYYYYYD..',
      '..DDDDDDDD..',
      '............',
    ],
    [
      '..K......K..',
      '.KGGGGGGGGK.',
      '..GGGTTGGG..',
      '..GGGGGGGG..',
      '...GGGGGG...',
      '..DYYYYYYD..',
      '..DDDDDDDD..',
      '............',
    ],
  ],
  fail: [
    [
      '....KKKK....',
      '...KGGGGK...',
      '..KGRRRGGK..',
      '..GGGGGGGG..',
      '...GGTTGG...',
      '..DDDDDDDD..',
      '..D......D..',
      '............',
    ],
  ],
};

const SCOUT_FRAME_SETS: Readonly<Record<SpriteState, readonly string[][]>> = {
  idle: [
    [
      '...SSSSSS...',
      '..SSKKKKSS..',
      '..SKGGGGKS..',
      '..GGTTTTGG..',
      '.CGGGGGGGGC.',
      '..CCCCCCCC..',
      '...C....C...',
      '............',
    ],
    [
      '...SSSSSS...',
      '..SSKKKKSS..',
      '..SKGGGGKS..',
      '..GGTT..GG..',
      '.CGGGGGGGGC.',
      '..CCCCCCCC..',
      '..C......C..',
      '............',
    ],
  ],
  work: [
    [
      '...SSSSSS...',
      '..SSKKKKSS..',
      '..SKGGGGKS..',
      '.CGGTTTTGGC.',
      '..CCCCCCCC..',
      '..CCYYYYCC..',
      '...C....C...',
      '............',
    ],
    [
      '...SSSSSS...',
      '..SSKKKKSS..',
      '..SKGGGGKS..',
      '.CGGTTTTGGC.',
      '.CCCCCCCCCC.',
      '..CYYYYYYC..',
      '..C......C..',
      '............',
    ],
    [
      '...SSSSSS...',
      '..SSKKKKSS..',
      '..SKGGGGKS..',
      '.CGGTTTTGGC.',
      'CCCCCCCCCCCC',
      '..CCYYYYCC..',
      '..C......C..',
      '............',
    ],
  ],
  done: [
    [
      '..SS....SS..',
      '.SSKKKKKKSS.',
      '..GGTTTTGG..',
      '.CGGGGGGGGC.',
      '...GGGGGG...',
      '..CCYYYYCC..',
      '..CCCCCCCC..',
      '............',
    ],
    [
      '.SS......SS.',
      'SSKKKKKKKKSS',
      '..GGTTTTGG..',
      '.CGGGGGGGGC.',
      '...GGGGGG...',
      '..CCYYYYCC..',
      '..CCCCCCCC..',
      '............',
    ],
  ],
  fail: [
    [
      '...SSSSSS...',
      '..SSKKKKSS..',
      '..SKGRRKS...',
      '.CGGTTTTGGC.',
      '..CCCCCCCC..',
      '.CCCCCCCCCC.',
      '..C......C..',
      '............',
    ],
  ],
};

let spritesPromise: Promise<SpriteMap> | undefined;

export function preloadSprites(): Promise<SpriteMap> {
  if (spritesPromise) {
    return spritesPromise;
  }

  spritesPromise = Promise.resolve().then(() => renderSpriteMap()).catch(error => {
    spritesPromise = undefined;
    throw error;
  });

  return spritesPromise;
}

export function renderSpriteMap(frameSets: Readonly<Record<SpriteState, readonly string[][]>> = FRAME_SETS): SpriteMap {
  const spriteMap: SpriteMap = new Map();

  for (const [state, frames] of Object.entries(frameSets) as Array<[SpriteState, readonly string[][]]>) {
    spriteMap.set(state, frames.map((frame, frameIndex) => renderFrame(state, frameIndex, frame)));
  }
  for (const [state, frames] of Object.entries(SCOUT_FRAME_SETS) as Array<[SpriteState, readonly string[][]]>) {
    spriteMap.set(`scout:${state}`, frames.map((frame, frameIndex) => renderFrame(state, frameIndex, frame)));
  }

  return spriteMap;
}

function renderFrame(state: SpriteState, frameIndex: number, frame: readonly string[]): string {
  return frame.map((row, rowIndex) => renderRow(state, frameIndex, rowIndex, row)).join('\n');
}

function renderRow(state: SpriteState, frameIndex: number, rowIndex: number, row: string): string {
  let rendered = '';

  for (const token of row as Iterable<string>) {
    rendered += renderToken(state, frameIndex, rowIndex, token);
  }

  return rendered;
}

function renderToken(state: SpriteState, frameIndex: number, rowIndex: number, token: string): string {
  if (token === '.') {
    return ' ';
  }

  const color = PALETTE[token as keyof typeof PALETTE];
  if (!color) {
    throw new Error(
      `Unknown sprite palette token "${token}" in ${state} frame ${frameIndex + 1} row ${rowIndex + 1}`,
    );
  }

  return chalk.hex(color)('█');
}
