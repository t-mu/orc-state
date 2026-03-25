import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import terminalImage from 'terminal-image';

export type SpriteState = 'idle' | 'work' | 'done' | 'fail';
export type SpriteMap = Map<SpriteState, string[]>;

export const FRAME_SETS: Readonly<Record<SpriteState, readonly string[]>> = {
  idle: ['idle-1.png', 'idle-2.png'],
  work: ['work-1.png', 'work-2.png', 'work-3.png'],
  done: ['done-1.png', 'done-2.png'],
  fail: ['fail-1.png'],
};

const SPRITES_DIR = fileURLToPath(new URL('../../assets/sprites/orc/', import.meta.url));
const RENDER_OPTIONS = {
  width: 16,
  preserveAspectRatio: true,
} as const;

let spritesPromise: Promise<SpriteMap> | undefined;

export function preloadSprites(): Promise<SpriteMap> {
  if (spritesPromise) {
    return spritesPromise;
  }

  spritesPromise = loadSprites().catch(error => {
    spritesPromise = undefined;
    throw error;
  });

  return spritesPromise;
}

async function loadSprites(): Promise<SpriteMap> {
  const spriteMap: SpriteMap = new Map();

  for (const [state, frames] of Object.entries(FRAME_SETS) as Array<[SpriteState, readonly string[]]>) {
    const renderedFrames: string[] = [];

    for (const frameName of frames) {
      const framePath = join(SPRITES_DIR, frameName);
      const frameBuffer = await readFrame(state, frameName, framePath);
      renderedFrames.push(await renderFrame(state, frameName, frameBuffer));
    }

    spriteMap.set(state, renderedFrames);
  }

  return spriteMap;
}

async function readFrame(state: SpriteState, frameName: string, framePath: string): Promise<Buffer> {
  try {
    return await readFile(framePath);
  } catch (error) {
    throw new Error(`Missing sprite frame for "${state}": ${frameName} (${framePath})`, {
      cause: error,
    });
  }
}

async function renderFrame(state: SpriteState, frameName: string, frameBuffer: Buffer): Promise<string> {
  try {
    return await terminalImage.buffer(frameBuffer, RENDER_OPTIONS);
  } catch (error) {
    throw new Error(`Failed to render sprite frame for "${state}": ${frameName}`, {
      cause: error,
    });
  }
}
