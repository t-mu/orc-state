import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadFile, mockRenderBuffer } = vi.hoisted(() => ({
  mockReadFile: vi.fn<(filePath: string) => Promise<Buffer>>(),
  mockRenderBuffer: vi.fn<(buffer: Uint8Array) => Promise<string>>(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('terminal-image', () => ({
  default: {
    buffer: mockRenderBuffer,
  },
}));

beforeEach(() => {
  vi.resetModules();
  mockReadFile.mockReset();
  mockRenderBuffer.mockReset();

  mockReadFile.mockImplementation(filePath => {
    const frameName = String(filePath).split('/').at(-1) ?? 'unknown.png';
    return Promise.resolve(Buffer.from(frameName, 'utf8'));
  });

  mockRenderBuffer.mockImplementation(buffer =>
    Promise.resolve(`rendered:${Buffer.from(buffer).toString('utf8')}`));
});

describe('preloadSprites', () => {
  it('loads all four states with deterministic frame ordering', async () => {
    const { preloadSprites } = await import('./sprites.ts');

    const spriteMap = await preloadSprites();

    expect(Array.from(spriteMap.keys())).toEqual(['idle', 'work', 'done', 'fail']);
    expect(spriteMap.get('idle')).toEqual(['rendered:idle-1.png', 'rendered:idle-2.png']);
    expect(spriteMap.get('work')).toEqual([
      'rendered:work-1.png',
      'rendered:work-2.png',
      'rendered:work-3.png',
    ]);
    expect(spriteMap.get('done')).toEqual(['rendered:done-1.png', 'rendered:done-2.png']);
    expect(spriteMap.get('fail')).toEqual(['rendered:fail-1.png']);
  });

  it('caches the rendered sprite map after the first load', async () => {
    const { preloadSprites } = await import('./sprites.ts');

    const firstLoad = await preloadSprites();
    const secondLoad = await preloadSprites();

    expect(secondLoad).toBe(firstLoad);
    expect(mockReadFile).toHaveBeenCalledTimes(8);
    expect(mockRenderBuffer).toHaveBeenCalledTimes(8);
  });

  it('throws a clear error when a declared frame file is missing', async () => {
    mockReadFile.mockImplementation(filePath => {
      const frameName = String(filePath).split('/').at(-1) ?? 'unknown.png';
      if (frameName === 'work-2.png') {
        return Promise.reject(new Error('ENOENT'));
      }

      return Promise.resolve(Buffer.from(frameName, 'utf8'));
    });

    const { preloadSprites } = await import('./sprites.ts');

    await expect(preloadSprites()).rejects.toThrow(/Missing sprite frame for "work": work-2\.png/);
  });

  it('clears the cache after a failed load so a retry can succeed', async () => {
    let shouldFail = true;
    mockReadFile.mockImplementation(filePath => {
      const frameName = String(filePath).split('/').at(-1) ?? 'unknown.png';
      if (shouldFail && frameName === 'fail-1.png') {
        return Promise.reject(new Error('ENOENT'));
      }

      return Promise.resolve(Buffer.from(frameName, 'utf8'));
    });

    const { preloadSprites } = await import('./sprites.ts');

    await expect(preloadSprites()).rejects.toThrow(/Missing sprite frame for "fail": fail-1\.png/);

    shouldFail = false;

    const spriteMap = await preloadSprites();

    expect(spriteMap.get('fail')).toEqual(['rendered:fail-1.png']);
  });
});
