import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

vi.mock('../lib/gitHosts/index.ts');

const { getGitHostAdapter } = await import('../lib/gitHosts/index.ts');
const { run } = await import('./pr-merge.ts');

let tempDir: string;
let configFile: string;
let mockExit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = createTempStateDir('orc-pr-merge-test-');
  configFile = join(tempDir, 'orc-state.config.json');
  vi.clearAllMocks();
  mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempStateDir(tempDir);
});

describe('cli/pr-merge.ts', () => {
  it('calls adapter.mergePr with the pr_ref argument', () => {
    writeFileSync(configFile, JSON.stringify({ pr_provider: 'github' }));
    const mockAdapter = { mergePr: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42'], configFile);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
    expect(mockAdapter.mergePr).toHaveBeenCalledWith('42');
  });

  it('exits 1 when pr_ref is missing', () => {
    writeFileSync(configFile, JSON.stringify({ pr_provider: 'github' }));

    expect(() => run([], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_provider is not configured', () => {
    writeFileSync(configFile, JSON.stringify({}));

    expect(() => run(['42'], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
