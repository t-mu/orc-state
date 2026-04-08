import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printMemoryWakeUp } from './memory-wake-up.ts';
import { closeMemoryDb, initMemoryDb, storeDrawer } from '../lib/memoryStore.ts';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('memory-wake-up-test-');
});

afterEach(() => {
  closeMemoryDb();
  cleanupTempStateDir(dir);
});

describe('printMemoryWakeUp', () => {
  it('exits 0 with informative message when memory.db missing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = printMemoryWakeUp(dir);
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain('not found');
  });

  it('prints formatted wake-up text when memory exists', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { content: 'important memory content', hall: 'hall1', room: 'notes', wing: 'general', importance: 9 });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = printMemoryWakeUp(dir);
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain('important memory content');
  });
});
