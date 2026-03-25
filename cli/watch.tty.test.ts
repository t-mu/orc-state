import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRender, mockPreloadSprites, mockWaitUntilExit, mockUnmount } = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockPreloadSprites: vi.fn(),
  mockWaitUntilExit: vi.fn(),
  mockUnmount: vi.fn(),
}));

vi.mock('ink', () => ({
  render: mockRender,
}));

vi.mock('../lib/tui/sprites.ts', () => ({
  preloadSprites: mockPreloadSprites,
}));

describe('cli/watch.ts TTY path', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockRender.mockReset();
    mockPreloadSprites.mockReset();
    mockWaitUntilExit.mockReset();
    mockUnmount.mockReset();

    mockWaitUntilExit.mockResolvedValue(undefined);
    mockRender.mockReturnValue({
      unmount: mockUnmount,
      waitUntilExit: mockWaitUntilExit,
      rerender: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
    });
    mockPreloadSprites.mockResolvedValue(new Map([
      ['idle', ['IDLE']],
      ['work', ['WORK']],
      ['done', ['DONE']],
      ['fail', ['FAIL']],
    ]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preloads sprites before rendering the Ink app', async () => {
    vi.stubGlobal('setImmediate', ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setImmediate);

    const { runTtyWatch } = await import('./watch.ts');
    const result = await runTtyWatch({ once: true, intervalMs: 1000, stateDir: '/tmp/orc-state' });

    expect(result).toBe(0);
    expect(mockPreloadSprites).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockPreloadSprites.mock.invocationCallOrder[0]).toBeLessThan(mockRender.mock.invocationCallOrder[0]);
  });

  it('unmounts after the first frame in once mode', async () => {
    vi.stubGlobal('setImmediate', ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setImmediate);

    const { runTtyWatch } = await import('./watch.ts');
    const result = await runTtyWatch({ once: true, intervalMs: 1000, stateDir: '/tmp/orc-state' });

    expect(result).toBe(0);
    expect(mockUnmount).toHaveBeenCalledTimes(1);
    expect(mockWaitUntilExit).toHaveBeenCalledTimes(1);
  });

  it('prints a clear error and exits 1 when sprite preload fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPreloadSprites.mockRejectedValue(new Error('bad palette'));

    const { runTtyWatch } = await import('./watch.ts');
    const result = await runTtyWatch({ once: true, intervalMs: 1000, stateDir: '/tmp/orc-state' });

    expect(result).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('Failed to preload watch sprites: bad palette');
    expect(mockRender).not.toHaveBeenCalled();
  });
});
