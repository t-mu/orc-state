import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports?: Record<string, string>; bin?: Record<string, string> };

function readLocalFile(relativePath: string) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('package.json contract', () => {
  it('keeps exports mapped to existing files', () => {
    const exportsMap = packageJson.exports ?? {};
    for (const relativePath of Object.values(exportsMap)) {
      if (relativePath.includes('*')) {
        const prefix = relativePath.split('*')[0];
        const absoluteDir = resolve(ROOT, prefix);
        expect(existsSync(absoluteDir), `${prefix} must exist`).toBe(true);
        continue;
      }
      const absolutePath = resolve(ROOT, relativePath);
      expect(existsSync(absolutePath), `${relativePath} must exist`).toBe(true);
    }
  });

  it('keeps CLI bins mapped to existing executable node entry files', () => {
    const bins = packageJson.bin ?? {};
    for (const [command, relativePath] of Object.entries(bins)) {
      expect(command === 'orc' || command.startsWith('orc-'), `${command} must be orc-prefixed`).toBe(true);
      const absolutePath = resolve(ROOT, relativePath);
      expect(existsSync(absolutePath), `${relativePath} must exist`).toBe(true);
      const source = readLocalFile(relativePath);
      expect(source.startsWith('#!/usr/bin/env'), `${relativePath} must have node shebang`).toBe(true);
    }
  });

  it('exports package root from index.ts', () => {
    expect(packageJson.exports?.['.']).toBe('./index.ts');
  });
});
