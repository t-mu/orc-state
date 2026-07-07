/**
 * lib/siblingLayoutCheck.ts
 *
 * Health check for the sibling orchestration layout (a `target_repo` is
 * configured, so the orchestration home and the product repo are different
 * directories). Pure and injectable so `orc doctor` / `orc preflight` can wire
 * it and unit tests can assert each check directly — mirrors
 * lib/sandboxDeps.ts.
 *
 * In the attached (single-repo) layout the check is skipped.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Unambiguous orchestration-framework artifacts. If any of these appear inside
// the target repo's working tree, framework files are leaking into the product
// repo — the exact thing the sibling layout exists to prevent. Kept to
// orc-specific names (not generic `backlog`/`plans`, which a product repo might
// legitimately own) to avoid false positives.
const ORC_ARTIFACTS = ['.orc-state', '.worktrees', 'orc-state.config.json'];

export interface SiblingLayoutCheck {
  ok: boolean;
  skipped: boolean;
  reason: string;
  errors: string[];
  warnings: string[];
}

export function checkSiblingLayout({
  isSibling,
  targetRepoRoot,
  stateDir,
}: {
  isSibling: boolean;
  targetRepoRoot: string;
  stateDir: string;
}): SiblingLayoutCheck {
  if (!isSibling) {
    return { ok: true, skipped: true, reason: 'attached layout (no target_repo configured)', errors: [], warnings: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. target_repo resolves to an existing git repository.
  if (!existsSync(targetRepoRoot)) {
    errors.push(`target_repo does not exist: ${targetRepoRoot}`);
  } else if (!isGitRepo(targetRepoRoot)) {
    errors.push(`target_repo is not a git repository: ${targetRepoRoot}`);
  }

  // 2. The state dir exists and is writable.
  if (!existsSync(stateDir)) {
    errors.push(`state dir does not exist: ${stateDir}`);
  } else if (!isWritable(stateDir)) {
    errors.push(`state dir is not writable: ${stateDir}`);
  }

  // 3. Warn (non-fatal) if framework artifacts leaked into the target repo.
  if (existsSync(targetRepoRoot)) {
    for (const artifact of ORC_ARTIFACTS) {
      if (existsSync(join(targetRepoRoot, artifact))) {
        warnings.push(`orc framework artifact present in the target repo working tree: ${artifact}`);
      }
    }
  }

  return { ok: errors.length === 0, skipped: false, reason: '', errors, warnings };
}

function isGitRepo(dir: string): boolean {
  return spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' }).status === 0;
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
