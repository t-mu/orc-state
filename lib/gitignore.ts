import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ENTRY = '.orc-state/';
const COMMENT = '# orc-state runtime data';

/**
 * Ensures `.orc-state/` is present in the project's `.gitignore`.
 * Silently skips if not inside a git repository.
 */
export function ensureGitignore(): void {
  try {
    const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const gitignorePath = join(root, '.gitignore');
    const contents = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    const lines = contents.split('\n').map((l) => l.trim());

    if (!lines.includes(ENTRY)) {
      appendFileSync(gitignorePath, `\n${COMMENT}\n${ENTRY}\n`);
      console.log(`Added ${ENTRY} to .gitignore`);
    }
  } catch {
    return;
  }
}
