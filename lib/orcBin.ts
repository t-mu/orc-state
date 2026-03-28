import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function resolveOnPath(binary: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function shellEscape(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`;
}

export function resolveOrcBin(repoRoot: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ORC_BIN?.trim();
  if (explicit) return explicit;

  const localInstall = repoRoot ? join(repoRoot, 'node_modules', '.bin', 'orc') : null;
  if (localInstall && existsSync(localInstall)) return localInstall;

  const fromPath = resolveOnPath('orc', env.PATH ?? process.env.PATH ?? '');
  if (fromPath) return fromPath;

  const sourceFallback = repoRoot ? join(repoRoot, 'cli', 'orc.ts') : null;
  if (sourceFallback && existsSync(sourceFallback)) return sourceFallback;

  return 'orc';
}

export function resolveOrcBinSh(repoRoot: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return shellEscape(resolveOrcBin(repoRoot, env));
}
