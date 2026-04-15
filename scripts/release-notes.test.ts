import { describe, expect, it } from 'vitest';
import {
  classifyReleaseCommit,
  extractReleaseSummary,
  groupReleaseCommits,
  renderReleaseSection,
  shouldIncludeReleaseCommit,
} from './release-notes.ts';

describe('scripts/release-notes.ts', () => {
  it('excludes internal workflow commits from release notes', () => {
    expect(shouldIncludeReleaseCommit('mark task done')).toBe(false);
    expect(shouldIncludeReleaseCommit('chore(backlog): add dynamic worker architecture tasks')).toBe(false);
    expect(shouldIncludeReleaseCommit('chore(release): v0.1.2')).toBe(false);
  });

  it('keeps user-facing feat/fix/docs commits in release notes', () => {
    expect(shouldIncludeReleaseCommit('feat(runtime): add dynamic provider routing')).toBe(true);
    expect(shouldIncludeReleaseCommit('fix(release): filter internal commits from changelog')).toBe(true);
    expect(shouldIncludeReleaseCommit('docs(cli): clarify init flow')).toBe(true);
  });

  it('preserves category grouping after filtering noisy commit subjects', () => {
    const grouped = groupReleaseCommits([
      'mark task done',
      'chore(backlog): add dynamic worker architecture tasks',
      'chore(release): v0.1.2',
      'feat(runtime): add dynamic provider routing',
      'fix(release): filter internal commits from changelog',
      'docs(cli): clarify init flow',
      'bump bundle size baseline',
    ]);

    expect(grouped).toEqual({
      added: ['add dynamic provider routing'],
      changed: ['clarify init flow'],
      fixed: ['filter internal commits from changelog'],
      other: ['bump bundle size baseline'],
    });
  });

  it('handles mixed commit samples without reintroducing mark task done', () => {
    const section = renderReleaseSection('0.2.5', '2026-04-15', [
      'mark task done',
      'chore(backlog): sync release automation backlog',
      'docs(cli): clarify init flow',
      'feat(runtime): add dynamic provider routing',
      'fix(release): filter internal commits from changelog',
      'chore(release): v0.2.4',
      'tune smoke harness output',
    ]);

    expect(section).toContain('## [0.2.5] - 2026-04-15');
    expect(section).toContain('### Added');
    expect(section).toContain('### Changed');
    expect(section).toContain('### Fixed');
    expect(section).toContain('### Other');
    expect(section).toContain('- add dynamic provider routing');
    expect(section).toContain('- clarify init flow');
    expect(section).toContain('- filter internal commits from changelog');
    expect(section).toContain('- tune smoke harness output');
    expect(section).not.toContain('mark task done');
    expect(section).not.toContain('sync release automation backlog');
    expect(section).not.toContain('v0.2.4');
  });

  it('keeps summary extraction and classification deterministic', () => {
    expect(extractReleaseSummary('docs(cli): clarify init flow')).toBe('clarify init flow');
    expect(extractReleaseSummary('mark task done')).toBe('mark task done');
    expect(classifyReleaseCommit('feat(runtime): add dynamic provider routing')).toBe('added');
    expect(classifyReleaseCommit('fix(release): filter internal commits from changelog')).toBe('fixed');
    expect(classifyReleaseCommit('docs(cli): clarify init flow')).toBe('changed');
    expect(classifyReleaseCommit('ship binary cache tuning')).toBe('other');
  });
});
