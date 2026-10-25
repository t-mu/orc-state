import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from './logger.ts';
import { ACTIVE_PROJECT } from './paths.ts';

const ENTRY = '.orc-state/';
const COMMENT = '# orc-state runtime data';

/**
 * Ensures `.orc-state/` is present in a legacy attached installation's
 * `.gitignore`. Silently skips if not inside a git repository.
 *
 * No-op for a registered project: its state lives outside the target
 * repository, which must never receive framework ignores.
 */
export function ensureGitignore({ project = ACTIVE_PROJECT !== null }: { project?: boolean } = {}): void {
  if (project) return;
  try {
    const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const gitignorePath = join(root, '.gitignore');
    const contents = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    const lines = contents.split('\n').map((l) => l.trim());

    if (!lines.includes(ENTRY)) {
      appendFileSync(gitignorePath, `\n${COMMENT}\n${ENTRY}\n`);
      logger.info(`Added ${ENTRY} to .gitignore`);
    }
  } catch {
    return;
  }
}
