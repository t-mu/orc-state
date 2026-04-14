import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { logger } from './logger.ts';

const EXECUTE_BITS = 0o111;

export function resolveInstalledNodePtyLibDir(
  resolveModule: (specifier: string) => string = createRequire(import.meta.url).resolve,
): string | null {
  const specifiers = [
    'node-pty/lib/unixTerminal.js',
    'node-pty/lib/utils.js',
  ];

  for (const specifier of specifiers) {
    try {
      return dirname(resolveModule(specifier));
    } catch {
      // Try the next known internal entrypoint.
    }
  }

  return null;
}

export function getNodePtySpawnHelperCandidates(
  libDir: string,
  platform = process.platform,
  arch = process.arch,
): string[] {
  const roots = ['..', '.'];
  const dirs = [
    'build/Release',
    'build/Debug',
    `prebuilds/${platform}-${arch}`,
  ];

  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const root of roots) {
    for (const dir of dirs) {
      const candidate = resolve(libDir, root, dir, 'spawn-helper');
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function ensureExecutableBit(path: string): boolean {
  if (!existsSync(path)) return false;

  const stats = statSync(path);
  if (!stats.isFile()) return false;
  if ((stats.mode & EXECUTE_BITS) === EXECUTE_BITS) return false;

  chmodSync(path, stats.mode | EXECUTE_BITS);
  return true;
}

export function ensureNodePtySpawnHelperPermissions(
  resolveModule?: (specifier: string) => string,
): void {
  if (process.platform === 'win32') return;

  const libDir = resolveInstalledNodePtyLibDir(resolveModule);
  if (!libDir) return;

  for (const candidate of getNodePtySpawnHelperCandidates(libDir)) {
    try {
      if (ensureExecutableBit(candidate)) {
        logger.warn(`[node-pty] repaired non-executable spawn-helper: ${candidate}`);
      }
    } catch (error) {
      logger.warn(`[node-pty] failed to repair spawn-helper ${candidate}: ${(error as Error).message}`);
    }
  }
}
