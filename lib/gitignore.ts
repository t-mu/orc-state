import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { logger } from './logger.ts';
import { IS_SIBLING_LAYOUT } from './paths.ts';

const ENTRY = '.orc-state/';
const COMMENT = '# orc-state runtime data';

/**
 * Ensures `.orc-state/` is present in the project's `.gitignore`.
 * Silently skips if not inside a git repository.
 *
 * No-op in the sibling layout: the process cwd there is not the product repo,
 * and the target repo must never receive framework ignores. The orchestration
 * repo's `.orc-state/` and `.worktrees/` ignores are owned by the
 * `orc init --sibling` scaffolding (task 191), not by this helper.
 */
export function ensureGitignore({ siblingLayout = IS_SIBLING_LAYOUT }: { siblingLayout?: boolean } = {}): void {
  if (siblingLayout) return;
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
