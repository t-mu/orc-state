import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

vi.mock('../lib/gitHosts/index.ts');

const { getGitHostAdapter } = await import('../lib/gitHosts/index.ts');
const { run } = await import('./pr-review.ts');

let tempDir: string;
let configFile: string;
let mockExit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = createTempStateDir('orc-pr-review-test-');
  configFile = join(tempDir, 'orc-state.config.json');
  vi.clearAllMocks();
  mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempStateDir(tempDir);
});

describe('cli/pr-review.ts', () => {
  it('calls adapter.submitReview with --approve', () => {
    writeFileSync(configFile, JSON.stringify({ pr_provider: 'github' }));
    const mockAdapter = { submitReview: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42', '--approve', '--body=LGTM'], configFile);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
    expect(mockAdapter.submitReview).toHaveBeenCalledWith('42', 'LGTM', true);
  });

  it('calls adapter.submitReview with --request-changes', () => {
    writeFileSync(configFile, JSON.stringify({ pr_provider: 'github' }));
    const mockAdapter = { submitReview: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42', '--request-changes', '--body=Needs work'], configFile);

    expect(mockAdapter.submitReview).toHaveBeenCalledWith('42', 'Needs work', false);
  });

  it('exits 1 when pr_ref is missing', () => {
    writeFileSync(configFile, JSON.stringify({ pr_provider: 'github' }));

    expect(() => run([], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_provider is not configured', () => {
    writeFileSync(configFile, JSON.stringify({}));

    expect(() => run(['42', '--approve'], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when neither --approve nor --request-changes is provided', () => {
    writeFileSync(configFile, JSON.stringify({ pr_provider: 'github' }));

    expect(() => run(['42', '--body=something'], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
