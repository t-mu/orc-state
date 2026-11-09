import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRender, mockWaitUntilExit, mockUnmount } = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockWaitUntilExit: vi.fn(),
  mockUnmount: vi.fn(),
}));

vi.mock('ink', () => ({
  render: mockRender,
}));

function fakeSource() {
  return { start: vi.fn(), stop: vi.fn(async () => {}), projects: vi.fn(() => []), onUpdate: vi.fn(() => () => {}) };
}

describe('cli/watch.ts TTY path', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockRender.mockReset();
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unmounts after the first frame in once mode', async () => {
    vi.stubGlobal('setImmediate', ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setImmediate);

    const { runTtyWatch } = await import('./watch.ts');
    const result = await runTtyWatch({ once: true, intervalMs: 1000, stateDir: '/tmp/orc-state', source: fakeSource() });

    expect(result).toBe(0);
    expect(mockUnmount).toHaveBeenCalledTimes(1);
    expect(mockWaitUntilExit).toHaveBeenCalledTimes(1);
  });

  it('renders the App from the watcher and stops it on exit', async () => {
    vi.stubGlobal('setImmediate', ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setImmediate);
    const source = fakeSource();

    const { runTtyWatch } = await import('./watch.ts');
    await runTtyWatch({ once: true, intervalMs: 1000, stateDir: '/tmp/orc-state', source });

    expect(source.start).toHaveBeenCalledTimes(1);
    expect(mockRender.mock.calls[0][0].props).toMatchObject({ source, stateDir: '/tmp/orc-state', intervalMs: 1000 });
    expect(source.stop).toHaveBeenCalledTimes(1);
  });
});
