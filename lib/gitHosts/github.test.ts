import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { GitHubAdapter } from './github.ts';
import { getGitHostAdapter } from './index.ts';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);

function makeResult(stdout: string, status = 0, stderr = '') {
  return { stdout, stderr, status, pid: 1, signal: null, output: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const adapter = new GitHubAdapter();

describe('createPr', () => {
  it('calls gh with correct arguments and returns URL', () => {
    mockedSpawnSync.mockReturnValue(makeResult('https://github.com/org/repo/pull/42\n'));
    const url = adapter.createPr('My PR', 'feature-branch', 'PR body');
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'create', '--title', 'My PR', '--head', 'feature-branch', '--body', 'PR body'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(url).toBe('https://github.com/org/repo/pull/42');
  });

  it('throws on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'error: not authenticated'));
    expect(() => adapter.createPr('title', 'branch', 'body')).toThrow(
      'gh pr create failed: error: not authenticated',
    );
  });
});

describe('checkPrStatus', () => {
  it('maps MERGED to merged', () => {
    mockedSpawnSync.mockReturnValue(makeResult('MERGED\n'));
    expect(adapter.checkPrStatus('42')).toBe('merged');
  });

  it('maps CLOSED to closed', () => {
    mockedSpawnSync.mockReturnValue(makeResult('CLOSED\n'));
    expect(adapter.checkPrStatus('42')).toBe('closed');
  });

  it('maps OPEN to open', () => {
    mockedSpawnSync.mockReturnValue(makeResult('OPEN\n'));
    expect(adapter.checkPrStatus('42')).toBe('open');
  });

  it('throws on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'PR not found'));
    expect(() => adapter.checkPrStatus('42')).toThrow('gh pr view failed: PR not found');
  });
});

describe('waitForCi', () => {
  it('calls gh pr checks --watch and returns passing on exit 0', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 0));
    const result = adapter.waitForCi('42');
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'checks', '42', '--watch'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(result).toBe('passing');
  });

  it('returns failing on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'checks failed'));
    expect(adapter.waitForCi('42')).toBe('failing');
  });
});

describe('mergePr', () => {
  it('calls gh pr merge with --squash', () => {
    mockedSpawnSync.mockReturnValue(makeResult(''));
    adapter.mergePr('42');
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '42', '--squash'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('throws on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'merge failed'));
    expect(() => adapter.mergePr('42')).toThrow('gh pr merge failed: merge failed');
  });
});

describe('submitReview', () => {
  it('passes --approve when approve is true', () => {
    mockedSpawnSync.mockReturnValue(makeResult(''));
    adapter.submitReview('42', 'LGTM', true);
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'review', '42', '--body', 'LGTM', '--approve'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('passes --request-changes when approve is false', () => {
    mockedSpawnSync.mockReturnValue(makeResult(''));
    adapter.submitReview('42', 'Needs work', false);
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'review', '42', '--body', 'Needs work', '--request-changes'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('throws on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'review failed'));
    expect(() => adapter.submitReview('42', 'body', true)).toThrow(
      'gh pr review failed: review failed',
    );
  });
});

describe('getPrDiff', () => {
  it('returns diff output', () => {
    mockedSpawnSync.mockReturnValue(makeResult('diff --git a/foo b/foo\n'));
    const diff = adapter.getPrDiff('42');
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'diff', '42'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(diff).toBe('diff --git a/foo b/foo');
  });

  it('throws on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'PR not found'));
    expect(() => adapter.getPrDiff('42')).toThrow('gh pr diff failed: PR not found');
  });
});

describe('getPrBody', () => {
  it('returns body text', () => {
    mockedSpawnSync.mockReturnValue(makeResult('This is the PR body\n'));
    const body = adapter.getPrBody('42');
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '42', '--json', 'body', '--jq', '.body'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(body).toBe('This is the PR body');
  });

  it('throws on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'PR not found'));
    expect(() => adapter.getPrBody('42')).toThrow('gh pr view failed: PR not found');
  });
});

describe('pushBranch', () => {
  it('calls git push with remote and branch', () => {
    mockedSpawnSync.mockReturnValue(makeResult(''));
    adapter.pushBranch('origin', 'feature-branch');
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'feature-branch'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('throws on non-zero exit', () => {
    mockedSpawnSync.mockReturnValue(makeResult('', 1, 'push rejected'));
    expect(() => adapter.pushBranch('origin', 'branch')).toThrow(
      'git push failed: push rejected',
    );
  });
});

describe('getGitHostAdapter factory', () => {
  it('returns GitHubAdapter for github', () => {
    const a = getGitHostAdapter('github');
    expect(a).toBeInstanceOf(GitHubAdapter);
  });

  it('throws for unsupported provider', () => {
    expect(() => getGitHostAdapter('gitlab')).toThrow(
      'Unsupported git host provider: gitlab. Supported: github',
    );
  });
});
