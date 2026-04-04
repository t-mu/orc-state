#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), 'orc-pack-smoke-'));
const cacheDir = join(tempRoot, 'npm-cache');
const extractRoot = join(tempRoot, 'extract');
const packageDir = join(extractRoot, 'package');
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

mkdirSync(cacheDir, { recursive: true });
mkdirSync(extractRoot, { recursive: true });

function run(command: string, args: string[], cwd: string): Buffer;
function run(command: string, args: string[], cwd: string, options: { encoding: 'utf8' }): string;
function run(command: string, args: string[], cwd: string, options: { encoding?: 'utf8' } = {}): Buffer | string {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, npm_config_cache: cacheDir },
    stdio: options.encoding ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.encoding,
  });
}

export function parsePackFilename(packOutput: string): string {
  const parsed = JSON.parse(packOutput) as Array<{ filename: string }>;
  if (!parsed[0]?.filename) {
    throw new Error(`npm pack --json returned unexpected payload:\n${packOutput}`);
  }
  return parsed[0].filename;
}

function findInstalledNodeModules(root: string): string {
  const candidates = [
    join(root, 'node_modules'),
    resolve(root, '..', '..', 'node_modules'),
  ];
  const match = candidates.find((candidate) => existsSync(join(candidate, 'node-pty')));
  if (!match) {
    throw new Error(`Could not locate node_modules for pack smoke test from ${root}`);
  }
  return match;
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath));
    } else {
      files.push(absolutePath);
    }
  }
  return files;
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isIdentifierBoundary(source: string, index: number): boolean {
  const char = source[index] ?? '';
  return char === '' || !/[A-Za-z0-9_$]/.test(char);
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && isWhitespace(source[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}

function readStringLiteral(source: string, index: number): { value: string; nextIndex: number } | null {
  const quote = source[index];
  if (quote !== '\'' && quote !== '"') return null;
  let value = '';
  let cursor = index + 1;

  while (cursor < source.length) {
    const char = source[cursor] ?? '';
    if (char === '\\') {
      value += char;
      cursor += 1;
      value += source[cursor] ?? '';
    } else if (char === quote) {
      return { value, nextIndex: cursor + 1 };
    } else {
      value += char;
    }
    cursor += 1;
  }

  return null;
}

function findSpecifierAfterFrom(source: string, index: number): { specifier: string; nextIndex: number } | null {
  let cursor = index;
  while (cursor < source.length) {
    if (source.startsWith('from', cursor) && isIdentifierBoundary(source, cursor - 1) && isIdentifierBoundary(source, cursor + 4)) {
      const afterFrom = skipWhitespace(source, cursor + 4);
      const literal = readStringLiteral(source, afterFrom);
      if (literal) {
        return { specifier: literal.value, nextIndex: literal.nextIndex };
      }
      return null;
    }
    if (source[cursor] === '\n' || source[cursor] === ';') {
      return null;
    }
    cursor += 1;
  }
  return null;
}

export function collectBareModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  let index = 0;
  let mode: 'code' | 'single' | 'double' | 'template' | 'lineComment' | 'blockComment' = 'code';

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (mode === 'code') {
      if (char === '\'') {
        mode = 'single';
      } else if (char === '"') {
        mode = 'double';
      } else if (char === '`') {
        mode = 'template';
      } else if (char === '/' && next === '/') {
        mode = 'lineComment';
        index += 1;
      } else if (char === '/' && next === '*') {
        mode = 'blockComment';
        index += 1;
      } else if (source.startsWith('require', index) && isIdentifierBoundary(source, index - 1) && isIdentifierBoundary(source, index + 7)) {
        let cursor = skipWhitespace(source, index + 7);
        if (source[cursor] === '(') {
          cursor = skipWhitespace(source, cursor + 1);
          const literal = readStringLiteral(source, cursor);
          if (literal) {
            specifiers.add(literal.value);
            index = literal.nextIndex;
            continue;
          }
        }
      } else if (source.startsWith('import', index) && isIdentifierBoundary(source, index - 1) && isIdentifierBoundary(source, index + 6)) {
        let cursor = skipWhitespace(source, index + 6);
        if (source[cursor] === '(') {
          cursor = skipWhitespace(source, cursor + 1);
          const literal = readStringLiteral(source, cursor);
          if (literal) {
            specifiers.add(literal.value);
            index = literal.nextIndex;
            continue;
          }
        } else {
          const literal = readStringLiteral(source, cursor);
          if (literal) {
            specifiers.add(literal.value);
            index = literal.nextIndex;
            continue;
          }
          const fromSpecifier = findSpecifierAfterFrom(source, cursor);
          if (fromSpecifier) {
            specifiers.add(fromSpecifier.specifier);
            index = fromSpecifier.nextIndex;
            continue;
          }
        }
      } else if (source.startsWith('export', index) && isIdentifierBoundary(source, index - 1) && isIdentifierBoundary(source, index + 6)) {
        const fromSpecifier = findSpecifierAfterFrom(source, index + 6);
        if (fromSpecifier) {
          specifiers.add(fromSpecifier.specifier);
          index = fromSpecifier.nextIndex;
          continue;
        }
      }
    } else if (mode === 'lineComment') {
      if (char === '\n') mode = 'code';
    } else if (mode === 'blockComment') {
      if (char === '*' && next === '/') {
        mode = 'code';
        index += 1;
      }
    } else if (char === '\\') {
      index += 1;
    } else if (
      (mode === 'single' && char === '\'')
      || (mode === 'double' && char === '"')
      || (mode === 'template' && char === '`')
    ) {
      mode = 'code';
    }

    index += 1;
  }

  return [...specifiers].filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'));
}

export function findUndeclaredRuntimeDependencies(
  packageRoot: string,
  packageJson: {
    name?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  },
): string[] {
  const declared = new Set([
    packageJson.name ?? '',
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ]);
  const missing = new Set<string>();
  const distRoot = join(packageRoot, 'dist');

  for (const file of listFiles(distRoot)) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs') && !file.endsWith('.cjs')) continue;
    const source = readFileSync(file, 'utf8');
    for (const specifier of collectBareModuleSpecifiers(source)) {
      if (BUILTIN_MODULES.has(specifier)) continue;
      const dependencyName = packageName(specifier);
      if (!declared.has(dependencyName)) {
        missing.add(dependencyName);
      }
    }
  }

  return [...missing].sort();
}

export function verifyPackedPackage(root: string): void {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const missingDependencies = findUndeclaredRuntimeDependencies(root, packageJson);
  if (missingDependencies.length > 0) {
    throw new Error(`packed package is missing runtime dependency declarations for: ${missingDependencies.join(', ')}`);
  }

  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import('./dist/index.js').then((m) => { if (typeof m.createAdapter !== 'function') throw new Error('missing createAdapter export'); console.log('package-export-ok'); })",
  ], root);

  const helpOutput = run(process.execPath, [join(root, 'dist', 'cli', 'orc.js'), '--help'], root, { encoding: 'utf8' });
  if (!helpOutput.includes('Usage: orc <subcommand>')) {
    throw new Error('installed orc binary did not print expected help output');
  }

  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import('./dist/lib/mcpConfig.js').then((m) => { const p = m.defaultServerPath(); if (!p.endsWith('/mcp/server.js')) throw new Error(`unexpected server path: ${p}`); console.log('mcp-path-ok'); })",
  ], root);

  const watchBundle = readFileSync(join(root, 'dist', 'cli', 'watch.js'), 'utf8');
  if (watchBundle.includes('.tsx') || watchBundle.includes('server.ts')) {
    throw new Error('installed watch bundle still contains stale TypeScript runtime references');
  }
  if (!watchBundle.includes('App.js') || !watchBundle.includes('sprites.js')) {
    throw new Error('installed watch bundle does not reference built TUI modules');
  }
}

export function runPackSmoke(): void {
  let tarballPath = '';
  try {
    const packJson = run('npm', ['pack', '--json'], repoRoot, { encoding: 'utf8' });
    const filename = parsePackFilename(packJson);
    tarballPath = join(repoRoot, filename);

    run('tar', ['-xzf', tarballPath, '-C', extractRoot], repoRoot);
    symlinkSync(findInstalledNodeModules(repoRoot), join(packageDir, 'node_modules'), 'dir');
    verifyPackedPackage(packageDir);

    console.log('pack smoke ok');
  } finally {
    if (tarballPath) {
      rmSync(tarballPath, { force: true });
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPackSmoke();
}
