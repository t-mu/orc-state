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
  const multiLineStart = packOutput.indexOf('[\n  {');
  const inlineStart = packOutput.indexOf('[{');
  const startCandidates = [multiLineStart, inlineStart].filter((index) => index !== -1);
  const start = startCandidates.length > 0 ? Math.min(...startCandidates) : -1;
  if (start === -1) {
    throw new Error(`npm pack --json did not return JSON output:\n${packOutput}`);
  }
  const end = packOutput.lastIndexOf(']');
  if (end === -1 || end < start) {
    throw new Error(`npm pack --json did not return a complete JSON array:\n${packOutput}`);
  }
  const parsed = JSON.parse(packOutput.slice(start, end + 1)) as Array<{ filename: string }>;
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

export function collectBareModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) continue;
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
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
    if (!file.endsWith('.js')) continue;
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
