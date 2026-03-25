import chalk from 'chalk';

export type SpriteState = 'idle' | 'work' | 'done' | 'fail';
export type SpriteMap = Map<SpriteState, string[]>;

type PaletteToken = '.' | 'G' | 'K' | 'T' | 'D' | 'Y' | 'R';

const PALETTE: Readonly<Record<Exclude<PaletteToken, '.'>, string>> = {
  G: '#59b45d',
  K: '#1c1c1c',
  T: '#f0e2c0',
  D: '#6f5f4d',
  Y: '#d4af37',
  R: '#ff3b30',
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
