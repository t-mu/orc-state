import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the real source checkout's CLI entrypoint. */
const REAL_CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_ORC_ENTRYPOINT = join(REAL_CHECKOUT_ROOT, 'cli', 'orc.ts');

/**
 * Writes a shell wrapper script into `<tempRepoRoot>/bin/orc` that invokes
 * the source CLI entrypoint from the real checkout under Node 24.
 *
 * Node 24 supports native TypeScript type stripping, so the source `.ts`
 * file can be run directly without a prebuilt dist artifact.
 *
 * The wrapper forwards all env vars set by the caller so ORC_REPO_ROOT,
 * ORC_STATE_DIR, and related overrides remain pinned to the temp repo.
 *
 * Returns the absolute path to the wrapper script. Set ORC_BIN to this
 * value or add the bin dir to PATH so worker PTYs resolve `orc` correctly.
 */
export function writeOrcWrapper(tempRepoRoot: string): string {
  const binDir = join(tempRepoRoot, 'bin');
  mkdirSync(binDir, { recursive: true });

  const wrapperPath = join(binDir, 'orc');

  const script = [
    '#!/bin/sh',
    '# Auto-generated orc wrapper — points at source checkout, not dist artifact.',
    `exec node ${JSON.stringify(REAL_ORC_ENTRYPOINT)} "$@"`,
  ].join('\n') + '\n';

  writeFileSync(wrapperPath, script, { encoding: 'utf8' });
  chmodSync(wrapperPath, 0o755);

  return wrapperPath;
}
