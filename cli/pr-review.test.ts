import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/gitHosts/index.ts');

const { getGitHostAdapter } = await import('../lib/gitHosts/index.ts');
const { run } = await import('./pr-review.ts');

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

describe('cli/pr-review.ts', () => {
  it('calls adapter.submitReview with --approve', () => {
    settings = { coordinator: { pr_provider: 'github' } };
    const mockAdapter = { submitReview: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42', '--approve', '--body=LGTM'], settings);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
    expect(mockAdapter.submitReview).toHaveBeenCalledWith('42', 'LGTM', true);
  });

  it('calls adapter.submitReview with --request-changes', () => {
    settings = { coordinator: { pr_provider: 'github' } };
    const mockAdapter = { submitReview: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42', '--request-changes', '--body=Needs work'], settings);

    expect(mockAdapter.submitReview).toHaveBeenCalledWith('42', 'Needs work', false);
  });

  it('reads pr_provider from coordinator config section', () => {
    settings = { coordinator: { pr_provider: 'github' } };
    const mockAdapter = { submitReview: vi.fn() };
    vi.mocked(getGitHostAdapter).mockReturnValue(mockAdapter as never);

    run(['42', '--approve'], settings);

    expect(getGitHostAdapter).toHaveBeenCalledWith('github');
  });

  it('exits 1 when coordinator.pr_provider is missing', () => {
    settings = { coordinator: {} };

    expect(() => run(['42', '--approve'], settings)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_ref is missing', () => {
    settings = { coordinator: { pr_provider: 'github' } };

    expect(() => run([], settings)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when pr_provider is not configured', () => {
    settings = {};

    expect(() => run(['42', '--approve'], settings)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when neither --approve nor --request-changes is provided', () => {
    settings = { coordinator: { pr_provider: 'github' } };

    expect(() => run(['42', '--body=something'], settings)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when no settings are stored', () => {
    expect(() => run(['42', '--approve'], {})).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
