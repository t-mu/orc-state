import { describe, expect, it } from 'vitest';
import FailureReporter, { failureLocation, formatFailure } from './vitest.failureReporter.mjs';

const ROOT = '/repo';

function assertionError(): Record<string, unknown> {
  return {
    name: 'AssertionError',
    message: 'expected 1 to be 2',
    diff: '- Expected\n+ Received',
    stack: [
      'AssertionError: expected 1 to be 2',
      '    at Object.toBe (/repo/node_modules/@vitest/expect/dist/index.js:10:5)',
      '    at /repo/e2e/clean-repo-project.e2e.test.ts:397:26',
      '    at file:///repo/e2e/other.ts:1:1',
    ].join('\n'),
  };
}

describe('vitest failure reporter', () => {
  it('locates a failure at its first frame outside node_modules', () => {
    expect(failureLocation(assertionError())).toEqual({ file: '/repo/e2e/clean-repo-project.e2e.test.ts', line: 397, column: 26 });
    expect(failureLocation({ stacks: [
      { file: '/repo/node_modules/vitest/x.js', line: 1, column: 1 },
      { file: '/repo/lib/a.ts', line: 7, column: 3 },
    ] })).toEqual({ file: '/repo/lib/a.ts', line: 7, column: 3 });
    expect(failureLocation({ message: 'no stack' })).toBeNull();
  });

  it('prints file:line, the full test name, the error and its diff', () => {
    const text = formatFailure({ title: 'suite > test', moduleId: '/repo/e2e/clean-repo-project.e2e.test.ts', error: assertionError(), root: ROOT });
    expect(text).toBe([
      'FAILED e2e/clean-repo-project.e2e.test.ts:397:26 > suite > test',
      'AssertionError: expected 1 to be 2',
      '- Expected\n+ Received',
      '',
    ].join('\n'));
  });

  it('adds an escaped GitHub annotation, and falls back to the file when no frame is known', () => {
    const located = formatFailure({ title: 'a, b: c', moduleId: '/repo/e2e/x.test.ts', error: assertionError(), root: ROOT, github: true });
    expect(located.trimEnd().split('\n').at(-1)).toBe(
      '::error file=e2e/clean-repo-project.e2e.test.ts,line=397,col=26,title=a%2C b%3A c::AssertionError: expected 1 to be 2');
    const bare = formatFailure({ title: 't', moduleId: '/repo/e2e/x.test.ts', error: { name: 'Error', message: 'line 1\nline 2' }, root: ROOT, github: true });
    expect(bare).toContain('FAILED e2e/x.test.ts > t\n');
    expect(bare).toContain('::error file=e2e/x.test.ts,title=t::Error: line 1%0Aline 2');
  });

  it('writes each failed test and failed file as it ends, and nothing for a pass', () => {
    const written: string[] = [];
    const reporter = new FailureReporter({ write: (text) => written.push(text) });
    reporter.onInit({ config: { root: ROOT } });
    const module = { moduleId: '/repo/e2e/x.test.ts', errors: () => [] as unknown[] };
    reporter.onTestCaseResult({ fullName: 'passes', module, result: () => ({ state: 'passed', errors: undefined }) });
    reporter.onTestModuleEnd(module);
    expect(written).toEqual([]);
    reporter.onTestCaseResult({ fullName: 'fails', module, result: () => ({ state: 'failed', errors: [assertionError()] }) });
    reporter.onTestModuleEnd({ ...module, errors: () => [{ name: 'Error', message: 'beforeAll failed' }] });
    expect(written).toHaveLength(2);
    expect(written[0]).toContain('FAILED e2e/clean-repo-project.e2e.test.ts:397:26 > fails');
    expect(written[1]).toContain('FAILED e2e/x.test.ts > e2e/x.test.ts (file)\nError: beforeAll failed');
  });
});
