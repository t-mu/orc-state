import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCodeIdentity, newestCodeMtimeMs, staleCodeWarning } from './codeIdentity.ts';

let root: string;
const touch = (file: string, seconds: number) => {
  writeFileSync(join(root, file), '');
  utimesSync(join(root, file), seconds, seconds);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orc-code-identity-'));
  mkdirSync(join(root, 'lib'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('code identity', () => {
  it('takes the newest entry or lib file, in .ts or .js, ignoring tests and declarations', () => {
    touch('coordinator.js', 100);
    touch('lib/a.js', 300);
    touch('lib/b.ts', 200);
    touch('lib/a.test.ts', 900);
    touch('lib/a.d.ts', 900);
    touch('lib/notes.md', 900);
    expect(newestCodeMtimeMs(root)).toBe(300_000);
    expect(captureCodeIdentity(root)).toEqual({ code_root: root, code_mtime: new Date(300_000).toISOString() });
  });

  it('is null for a tree with no code', () => {
    expect(newestCodeMtimeMs(join(root, 'missing'))).toBeNull();
    expect(staleCodeWarning({ code_root: join(root, 'missing'), code_mtime: new Date(0).toISOString() })).toBeNull();
  });

  it('warns only when the disk is newer than what the coordinator loaded', () => {
    touch('coordinator.ts', 100);
    const running = captureCodeIdentity(root);
    expect(staleCodeWarning(running)).toBeNull();
    touch('lib/x.ts', 500);
    expect(staleCodeWarning(running)).toBe(`coordinator is running code from ${running.code_mtime}; restart with orc start-session`);
  });
});
