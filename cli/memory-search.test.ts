import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMemorySearch } from './memory-search.ts';
import { closeMemoryDb, initMemoryDb, storeDrawer } from '../lib/memoryStore.ts';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('memory-search-test-');
});

afterEach(() => {
  closeMemoryDb();
  cleanupTempStateDir(dir);
});

describe('runMemorySearch', () => {
  it('exits 0 with informative message when memory.db missing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = runMemorySearch(dir, 'test query');
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain('not found');
  });

  it('prints "No results found." when query matches nothing', () => {
    initMemoryDb(dir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = runMemorySearch(dir, 'xyzzyquux');
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain('No results found.');
  });

  it('prints FTS5 results with snippets', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { content: 'the quick brown fox jumps', hall: 'hall1', room: 'animals', wing: 'general' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = runMemorySearch(dir, 'fox');
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain('quick brown fox');
  });
});
