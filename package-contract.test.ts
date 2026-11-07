import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE } from './cli/usage.ts';
import { PROJECT_SETTING_KEYS } from './lib/projectRegistry.ts';
import { TOOLS } from './mcp/tools-list.ts';

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

/** The source a `./dist/...` path is built from (`.js`/`.d.ts` from `.ts`; JSON copied as is). */
function sourceOf(distPath: string): string {
  return distPath.replace(/^\.\/dist\//, './').replace(/\.d\.ts$|\.js$/, '.ts');
}

const PUBLIC_SURFACE = /^## Public surface \(semver\)\n([\s\S]*?)(?=^## )/m.exec(readLocalFile('docs/contracts.md'))?.[1] ?? '';

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

  it('exports only the package root and the schemas', () => {
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual(['.', './schemas/*']);
  });

  it('builds every export from an existing source', () => {
    for (const exportValue of Object.values(packageJson.exports ?? {})) {
      for (const distPath of exportPaths(exportValue)) {
        const source = sourceOf(distPath);
        const prefix = source.split('*')[0];
        expect(existsSync(resolve(ROOT, prefix)), `${distPath} is built from ${source}`).toBe(true);
      }
    }
  });

  it('documents the public surface in docs/contracts.md', () => {
    expect(PUBLIC_SURFACE).not.toBe('');
    for (const specifier of ['`orc-state`', '`orc-state/schemas/<name>.json`']) expect(PUBLIC_SURFACE).toContain(specifier);
    for (const command of Object.keys(USAGE)) expect(PUBLIC_SURFACE, `CLI command ${command}`).toContain(`\`${command}\``);
    for (const tool of TOOLS) expect(PUBLIC_SURFACE, `MCP tool ${tool.name}`).toContain(`\`${tool.name}\``);
    for (const key of PROJECT_SETTING_KEYS) {
      const leaf = key.startsWith('worker_pool.provider_models.') ? 'provider_models' : key.split('.').at(-1)!;
      expect(PUBLIC_SURFACE, `setting ${key}`).toContain(`\`${leaf}\``);
    }
  });

  it('exports package root from index.ts', () => {
    const rootExport = packageJson.exports?.['.'];
    const defaultPath = typeof rootExport === 'string' ? rootExport : rootExport?.default;
    expect(defaultPath).toBe('./dist/index.js');
  });
});
