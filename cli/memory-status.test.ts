import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printMemoryStatus } from './memory-status.ts';
import { closeMemoryDb, initMemoryDb, storeDrawer } from '../lib/memoryStore.ts';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('memory-status-test-');
});

afterEach(() => {
  closeMemoryDb();
  cleanupTempStateDir(dir);
});

describe('printMemoryStatus', () => {
  it('prints memory stats', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { content: 'test content', hall: 'hall1', room: 'room1', wing: 'general' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = printMemoryStatus(dir);
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain('Drawers: 1');
    expect(output).toContain('Wings:   1');
    expect(output).toContain('DB size:');
  });

  it('exits 0 with info message when memory.db missing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = printMemoryStatus(dir);
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain('not found');
  });
});
