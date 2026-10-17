import { spawnSync } from 'node:child_process';
import type { GitHostAdapter } from './interface.ts';
import { HERMETIC_GIT_CONFIG_ARGS } from '../gitPlumbing.ts';

export class GitHubAdapter implements GitHostAdapter {
  // cwd scopes every gh/git invocation to a specific checkout. In the sibling
  // layout the coordinator runs from the orchestration root, so it passes the
  // target repo root here; otherwise cwd is undefined and spawnSync falls back
  // to process.cwd() (the pre-sibling behavior, and correct for worker-invoked
  // PR CLIs whose cwd is already the target-repo worktree).
  // NB: explicit field + assignment, not a TS parameter property — Node 24
  // strip-only type stripping (no build step) rejects parameter properties.
  private readonly cwd: string | undefined;

  constructor(cwd?: string) {
    this.cwd = cwd;
  }

  // Include cwd in spawn options only when set — a literal `cwd: undefined`
  // is rejected under exactOptionalPropertyTypes.
  private cwdOpt(): { cwd: string } | Record<string, never> {
    return this.cwd !== undefined ? { cwd: this.cwd } : {};
  }

  private run(args: string[]): string {
    const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...this.cwdOpt() });
    if (result.status !== 0) {
      throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  pushBranch(remote: string, branch: string): void {
    // Coordinator-side push against the target repo (cwd = TARGET_REPO_ROOT in
    // the sibling layout). Run it hermetically — matching pushMain and the
    // other coordinator git ops — so the product repo's pre-push hook does not
    // fire and no fsmonitor daemon is spawned during automated PR pushes.
    const result = spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, 'push', '--set-upstream', remote, branch], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...this.cwdOpt(),
    });
    if (result.status !== 0) {
      throw new Error(`git push failed: ${result.stderr}`);
    }
  }

  createPr(title: string, branch: string, body: string): string {
    const existing = this.run(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // empty']);
    if (existing) return existing;
    return this.run(['pr', 'create', '--title', title, '--head', branch, '--body', body]);
  }

  checkPrStatus(prRef: string): 'open' | 'merged' | 'closed' {
    const state = this.run(['pr', 'view', prRef, '--json', 'state', '--jq', '.state']);
    if (state === 'MERGED') return 'merged';
    if (state === 'CLOSED') return 'closed';
    return 'open';
  }

  waitForCi(prRef: string): 'passing' | 'failing' {
    const result = spawnSync('gh', ['pr', 'checks', prRef, '--watch'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...this.cwdOpt(),
    });
    return result.status === 0 ? 'passing' : 'failing';
  }

  mergePr(prRef: string): void {
    if (this.checkPrStatus(prRef) === 'merged') return;
    this.run(['pr', 'merge', prRef, '--squash']);
  }

  submitReview(prRef: string, body: string, approve: boolean): void {
    const flag = approve ? '--approve' : '--request-changes';
    this.run(['pr', 'review', prRef, '--body', body, flag]);
  }

  getPrBody(prRef: string): string {
    return this.run(['pr', 'view', prRef, '--json', 'body', '--jq', '.body']);
  }

  getPrDiff(prRef: string): string {
    return this.run(['pr', 'diff', prRef]);
  }
}
