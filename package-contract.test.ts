import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
type ExportValue = string | { types?: string; default?: string };
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports?: Record<string, ExportValue>; bin?: Record<string, string> };

function readLocalFile(relativePath: string) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function exportPaths(value: ExportValue): string[] {
  if (typeof value === 'string') return [value];
  return [value.default, value.types].filter((p): p is string => p !== undefined);
}

function isGeneratedBuildPath(relativePath: string): boolean {
  return relativePath.startsWith('./dist/');
}

describe('package.json contract', () => {
  it('keeps exports mapped to existing files', () => {
    const exportsMap = packageJson.exports ?? {};
    for (const exportValue of Object.values(exportsMap)) {
      for (const relativePath of exportPaths(exportValue)) {
        if (isGeneratedBuildPath(relativePath)) continue;
        if (relativePath.includes('*')) {
          const prefix = relativePath.split('*')[0];
          const absoluteDir = resolve(ROOT, prefix);
          expect(existsSync(absoluteDir), `${prefix} must exist`).toBe(true);
          continue;
        }
        const absolutePath = resolve(ROOT, relativePath);
        expect(existsSync(absolutePath), `${relativePath} must exist`).toBe(true);
      }
    }
  });

  it('keeps CLI bins mapped to existing executable node entry files', () => {
    const bins = packageJson.bin ?? {};
    for (const [command, relativePath] of Object.entries(bins)) {
      expect(command === 'orc' || command.startsWith('orc-'), `${command} must be orc-prefixed`).toBe(true);
      expect(relativePath.startsWith('./'), `${relativePath} must be package-relative`).toBe(true);
      if (isGeneratedBuildPath(relativePath)) continue;
      const absolutePath = resolve(ROOT, relativePath);
      expect(existsSync(absolutePath), `${relativePath} must exist`).toBe(true);
      const source = readLocalFile(relativePath);
      expect(source.startsWith('#!/usr/bin/env'), `${relativePath} must have node shebang`).toBe(true);
    }
  });

  it('exports package root from index.ts', () => {
    const rootExport = packageJson.exports?.['.'];
    const defaultPath = typeof rootExport === 'string' ? rootExport : rootExport?.default;
    expect(defaultPath).toBe('./dist/index.js');
  });
});
