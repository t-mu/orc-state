import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-atomic-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteJson', () => {
  it('writes JSON to the target file', () => {
    const filePath = join(dir, 'test.json');
    atomicWriteJson(filePath, { version: '1', items: [1, 2, 3] });

    const content = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ version: '1', items: [1, 2, 3] });
  });

  it('output ends with a newline', () => {
    const filePath = join(dir, 'test.json');
    atomicWriteJson(filePath, { x: 1 });
    const content = readFileSync(filePath, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('overwrites an existing file atomically', () => {
    const filePath = join(dir, 'test.json');
    atomicWriteJson(filePath, { value: 'old' });
    atomicWriteJson(filePath, { value: 'new' });

    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.value).toBe('new');
  });

  it('leaves no .tmp file behind on success', () => {
    const filePath = join(dir, 'test.json');
    atomicWriteJson(filePath, { ok: true });
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it('pretty-prints JSON with 2-space indent', () => {
    const filePath = join(dir, 'test.json');
    atomicWriteJson(filePath, { a: 1, b: [2, 3] });
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('\n  ');
  });

  it('creates parent path if target file does not exist yet', () => {
    const filePath = join(dir, 'brand-new.json');
    expect(existsSync(filePath)).toBe(false);
    atomicWriteJson(filePath, { created: true });
    expect(existsSync(filePath)).toBe(true);
  });

  it('can roundtrip complex nested data', () => {
    const filePath = join(dir, 'complex.json');
    const data = {
      version: '1',
      epics: [
        { ref: 'orch', title: 'Orchestration', tasks: [{ ref: 'orch/init', status: 'todo' }] },
      ],
    };
    atomicWriteJson(filePath, data);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed).toEqual(data);
  });
});
