import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-atomic-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
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
      features: [
        { ref: 'orch', title: 'Orchestration', tasks: [{ ref: 'orch/init', status: 'todo' }] },
      ],
    };
    atomicWriteJson(filePath, data);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed).toEqual(data);
  });
});
