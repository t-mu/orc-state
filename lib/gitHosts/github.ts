import { spawnSync } from 'node:child_process';
import type { GitHostAdapter } from './interface.ts';

function run(args: string[]): string {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export class GitHubAdapter implements GitHostAdapter {
  pushBranch(remote: string, branch: string): void {
    const result = spawnSync('git', ['push', '--set-upstream', remote, branch], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`git push failed: ${result.stderr}`);
    }
  }

  createPr(title: string, branch: string, body: string): string {
    return run(['pr', 'create', '--title', title, '--head', branch, '--body', body]);
  }

  checkPrStatus(prRef: string): 'open' | 'merged' | 'closed' {
    const state = run(['pr', 'view', prRef, '--json', 'state', '--jq', '.state']);
    if (state === 'MERGED') return 'merged';
    if (state === 'CLOSED') return 'closed';
    return 'open';
  }

  waitForCi(prRef: string): 'passing' | 'failing' {
    const result = spawnSync('gh', ['pr', 'checks', prRef, '--watch'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.status === 0 ? 'passing' : 'failing';
  }

  mergePr(prRef: string): void {
    run(['pr', 'merge', prRef, '--squash']);
  }

  submitReview(prRef: string, body: string, approve: boolean): void {
    const flag = approve ? '--approve' : '--request-changes';
    run(['pr', 'review', prRef, '--body', body, flag]);
  }

  getPrBody(prRef: string): string {
    return run(['pr', 'view', prRef, '--json', 'body', '--jq', '.body']);
  }

  getPrDiff(prRef: string): string {
    return run(['pr', 'diff', prRef]);
  }
}
