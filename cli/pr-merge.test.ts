import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/gitHosts/index.ts');

const { getGitHostAdapter } = await import('../lib/gitHosts/index.ts');
const { run } = await import('./pr-merge.ts');

let settings: Record<string, unknown>;
let mockExit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  settings = {};
  vi.clearAllMocks();
  mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cli/pr-merge.ts', () => {
  it('calls adapter.mergePr with the pr_ref argument', () => {
    settings = { coordinator: { pr_provider: 'github' } };
    const mockAdapter = { mergePr: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42'], settings);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
    expect(mockAdapter.mergePr).toHaveBeenCalledWith('42');
  });

  it('reads pr_provider from coordinator config section', () => {
    settings = { coordinator: { pr_provider: 'github' } };
    const mockAdapter = { mergePr: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42'], settings);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
  });

  it('exits 1 when coordinator.pr_provider is missing', () => {
    settings = { coordinator: {} };

    expect(() => run(['42'], settings)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_ref is missing', () => {
    settings = { coordinator: { pr_provider: 'github' } };

    expect(() => run([], settings)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_provider is not configured', () => {
    settings = {};

    expect(() => run(['42'], settings)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when no settings are stored', () => {
    expect(() => run(['42'], {})).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
