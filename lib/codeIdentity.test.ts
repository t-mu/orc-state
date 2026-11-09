import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_ID_FILE, captureCodeIdentity, newestCodeMtimeMs, readBuildId, staleCodeWarning } from './codeIdentity.ts';

let base: string;
let root: string;
const touch = (file: string, seconds: number) => {
  writeFileSync(join(root, file), '');
  utimesSync(join(root, file), seconds, seconds);
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orc-code-identity-'));
  root = join(base, 'dist');
  mkdirSync(root);
  mkdirSync(join(root, 'lib'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('code identity', () => {
  it('takes the newest entry or lib file, in .ts or .js, ignoring tests and declarations', () => {
    touch('coordinator.js', 100);
    touch('lib/a.js', 300);
    touch('lib/b.ts', 200);
    touch('lib/a.test.ts', 900);
    touch('lib/a.d.ts', 900);
    touch('lib/notes.md', 900);
    expect(newestCodeMtimeMs(root)).toBe(300_000);
    expect(captureCodeIdentity(root)).toEqual({ code_root: root, code_mtime: new Date(300_000).toISOString(), build_id: null });
  });

  it('is null for a tree with no code', () => {
    expect(newestCodeMtimeMs(join(root, 'missing'))).toBeNull();
    expect(staleCodeWarning({ code_root: join(root, 'missing'), code_mtime: new Date(0).toISOString(), build_id: null })).toBeNull();
  });

  it('warns only when the disk is newer than what the coordinator loaded', () => {
    touch('coordinator.ts', 100);
    const running = captureCodeIdentity(root);
    expect(staleCodeWarning(running)).toBeNull();
    touch('lib/x.ts', 500);
    expect(staleCodeWarning(running)).toBe(`coordinator is running code from ${running.code_mtime}; restart with orc coordinator restart`);
  });

  describe('built code (dist, mtimes normalised)', () => {
    const build = (id: string, version = '1.0.0') => {
      writeFileSync(join(root, BUILD_ID_FILE), `${id}\n`);
      writeFileSync(join(root, '..', 'package.json'), JSON.stringify({ version }));
    };
    const normalised = 499_000_000; // npm sets tarball mtimes to 1985

    it('reads the build id the build wrote', () => {
      build('abc123');
      expect(readBuildId(root)).toBe('abc123');
      expect(captureCodeIdentity(root).build_id).toBe('abc123');
    });

    it('warns when the build id on disk changed, though no file is newer', () => {
      touch('coordinator.js', normalised);
      build('old');
      const running = captureCodeIdentity(root);
      expect(staleCodeWarning(running)).toBeNull();
      writeFileSync(join(root, BUILD_ID_FILE), 'new\n');
      expect(staleCodeWarning(running)).toBe('coordinator is running build old, disk has new; restart with orc coordinator restart');
    });

    it('warns when the package version on disk changed', () => {
      touch('coordinator.js', normalised);
      build('same', '1.1.0');
      const running = { ...captureCodeIdentity(root), version: '1.0.0' };
      expect(staleCodeWarning(running)).toBe('coordinator is running version 1.0.0, disk has 1.1.0; restart with orc coordinator restart');
      expect(staleCodeWarning({ ...running, version: '1.1.0' })).toBeNull();
    });

    it('warns when the coordinator reports no identity at all, but not when the disk has none either', () => {
      touch('coordinator.js', normalised);
      const legacy = { code_root: root, code_mtime: new Date(normalised * 1000).toISOString(), build_id: null };
      expect(staleCodeWarning(legacy)).toBeNull(); // disk side unknowable
      build('abc');
      expect(staleCodeWarning(legacy)).toBe('coordinator reports no build id (older than this build); restart with orc coordinator restart');
      expect(staleCodeWarning({ ...legacy, build_id: 'abc' })).toBeNull();
    });

    it('does not use mtimes for built code', () => {
      touch('coordinator.js', normalised);
      build('same');
      const running = captureCodeIdentity(root);
      touch('lib/x.js', 5_000_000_000);
      expect(staleCodeWarning(running)).toBeNull();
    });
  });
});
