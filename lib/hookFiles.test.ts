import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gcOrphanedHookFiles, hookFileAgentId } from './hookFiles.ts';

describe('hookFileAgentId', () => {
  it('reads the agent from every hook-file name', () => {
    expect(hookFileAgentId('bob.ndjson')).toBe('bob');
    expect(hookFileAgentId('bob.ndjson.processing')).toBe('bob');
    expect(hookFileAgentId('scout-1.ndjson.tasks.json')).toBe('scout-1');
    expect(hookFileAgentId('broken-nose.ndjson.tasks.json.4242.tmp')).toBe('broken-nose');
  });

  it('returns null for a file that does not follow the naming', () => {
    expect(hookFileAgentId('README')).toBeNull();
    expect(hookFileAgentId('.ndjson')).toBeNull();
  });
});

describe('gcOrphanedHookFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orc-hookfiles-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('removes files of unregistered agents and keeps registered and unrelated ones', () => {
    const events = join(dir, 'pty-hook-events');
    mkdirSync(events);
    for (const name of [
      'alive.ndjson', 'alive.ndjson.tasks.json',
      'gone.ndjson', 'gone.ndjson.processing', 'gone.ndjson.tasks.json', 'gone.ndjson.tasks.json.7.tmp',
      'notes.txt',
    ]) writeFileSync(join(events, name), '');

    const removed = gcOrphanedHookFiles(dir, ['alive', 'master']);

    expect(removed.sort()).toEqual(['gone.ndjson', 'gone.ndjson.processing', 'gone.ndjson.tasks.json', 'gone.ndjson.tasks.json.7.tmp']);
    expect(readdirSync(events).sort()).toEqual(['alive.ndjson', 'alive.ndjson.tasks.json', 'notes.txt']);
  });

  it('is a no-op without a hook-events directory', () => {
    expect(gcOrphanedHookFiles(dir, [])).toEqual([]);
  });
});
