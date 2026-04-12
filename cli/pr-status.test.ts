import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

vi.mock('../lib/gitHosts/index.ts');

const { getGitHostAdapter } = await import('../lib/gitHosts/index.ts');
const { run } = await import('./pr-status.ts');

let tempDir: string;
let configFile: string;
let mockExit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = createTempStateDir('orc-pr-status-test-');
  configFile = join(tempDir, 'orc-state.config.json');
  vi.clearAllMocks();
  mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempStateDir(tempDir);
});

describe('cli/pr-status.ts', () => {
  it('calls adapter.checkPrStatus with the pr_ref argument', () => {
    writeFileSync(configFile, JSON.stringify({ coordinator: { pr_provider: 'github' } }));
    const mockAdapter = { checkPrStatus: vi.fn().mockReturnValue('open'), waitForCi: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42'], configFile);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
    expect(mockAdapter.checkPrStatus).toHaveBeenCalledWith('42');
  });

  it('calls adapter.waitForCi when --wait is passed', () => {
    writeFileSync(configFile, JSON.stringify({ coordinator: { pr_provider: 'github' } }));
    const mockAdapter = { checkPrStatus: vi.fn(), waitForCi: vi.fn().mockReturnValue('passing') };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42', '--wait'], configFile);

    expect(mockAdapter.waitForCi).toHaveBeenCalledWith('42');
    expect(mockAdapter.checkPrStatus).not.toHaveBeenCalled();
  });

  it('reads pr_provider from coordinator config section', () => {
    writeFileSync(configFile, JSON.stringify({ coordinator: { pr_provider: 'github' } }));
    const mockAdapter = { checkPrStatus: vi.fn().mockReturnValue('open'), waitForCi: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42'], configFile);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
  });

  it('exits 1 when coordinator.pr_provider is missing', () => {
    writeFileSync(configFile, JSON.stringify({ coordinator: {} }));

    expect(() => run(['42'], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_ref is missing', () => {
    writeFileSync(configFile, JSON.stringify({ coordinator: { pr_provider: 'github' } }));

    expect(() => run([], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_provider is not configured', () => {
    writeFileSync(configFile, JSON.stringify({}));

    expect(() => run(['42'], configFile)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when config file does not exist', () => {
    expect(() => run(['42'], join(tempDir, 'nonexistent.json'))).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
