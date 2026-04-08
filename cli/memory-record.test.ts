import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordMemory } from './memory-record.ts';
import { closeMemoryDb, getDrawer, initMemoryDb } from '../lib/memoryStore.ts';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('memory-record-test-');
});

afterEach(() => {
  closeMemoryDb();
  cleanupTempStateDir(dir);
});

describe('recordMemory', () => {
  it('stores a drawer and prints the ID', () => {
    initMemoryDb(dir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = recordMemory(dir, { content: 'test memory content' });
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toMatch(/stored: drawer \d+/);
  });

  it('uses --wing and --room flags', () => {
    initMemoryDb(dir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = recordMemory(dir, { content: 'wing room test content', wing: 'my-wing', room: 'my-room' });
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toMatch(/stored: drawer \d+/);

    // Verify the drawer was stored with the specified wing and room
    const idMatch = /stored: drawer (\d+)/.exec(output);
    expect(idMatch).not.toBeNull();
    closeMemoryDb();
    initMemoryDb(dir);
    const drawer = getDrawer(dir, Number(idMatch![1]));
    expect(drawer).not.toBeNull();
    expect(drawer!.wing).toBe('my-wing');
    expect(drawer!.room).toBe('my-room');
  });
});
