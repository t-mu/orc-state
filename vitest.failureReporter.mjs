// Vitest reporter for CI: prints each failure the moment its test (or file)
// fails, instead of only in the end-of-run summary. A run whose vitest process
// dies before the summary — a worker or the main process killed, the job
// cancelled — still shows every assertion that failed so far with its
// file:line. Under GitHub Actions each failure is also an `::error`
// annotation. Writes are synchronous so nothing is lost to a buffered stream
// when the process ends right after.
import { writeSync } from 'node:fs';
import { relative } from 'node:path';

const FRAME = /\(?((?:file:\/\/)?\/[^()\s]+?):(\d+):(\d+)\)?\s*$/;

/** The first stack frame outside node_modules and vitest internals, or null. */
export function failureLocation(error) {
  for (const frame of error?.stacks ?? []) {
    if (frame.file && !frame.file.includes('/node_modules/')) return { file: frame.file, line: frame.line, column: frame.column };
  }
  for (const line of String(error?.stack ?? '').split('\n').slice(1)) {
    const match = FRAME.exec(line.trim());
    if (!match) continue;
    const file = match[1].replace(/^file:\/\//, '');
    if (file.includes('/node_modules/') || file.startsWith('node:')) continue;
    return { file, line: Number(match[2]), column: Number(match[3]) };
  }
  return null;
}

function escapeData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * The lines printed for one failure: a header with file:line and the test's
 * full name, the error and its diff, and with `github` an `::error` annotation.
 */
export function formatFailure({ title, moduleId, error, root = process.cwd(), github = false }) {
  const location = failureLocation(error);
  const file = location?.file ?? moduleId;
  const where = location ? `${relative(root, file)}:${location.line}:${location.column}` : relative(root, moduleId);
  const message = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
  const lines = [`FAILED ${where} > ${title}`, message];
  if (error?.diff) lines.push(error.diff);
  if (error?.cause) lines.push(`Caused by: ${error.cause.name ?? 'Error'}: ${error.cause.message ?? String(error.cause)}`);
  if (github) {
    const properties = [`file=${escapeProperty(relative(root, file))}`];
    if (location) properties.push(`line=${location.line}`, `col=${location.column}`);
    properties.push(`title=${escapeProperty(title)}`);
    lines.push(`::error ${properties.join(',')}::${escapeData(message)}`);
  }
  return `${lines.join('\n')}\n`;
}

export default class FailureReporter {
  constructor({ github = process.env.GITHUB_ACTIONS === 'true', write = (text) => writeSync(2, text) } = {}) {
    this.github = github;
    this.write = write;
    this.root = process.cwd();
  }

  onInit(vitest) {
    this.root = vitest.config.root;
  }

  print(title, moduleId, errors) {
    for (const error of errors ?? []) {
      this.write(`\n${formatFailure({ title, moduleId, error, root: this.root, github: this.github })}`);
    }
  }

  onTestCaseResult(testCase) {
    const result = testCase.result();
    if (result.state === 'failed') this.print(testCase.fullName, testCase.module.moduleId, result.errors);
  }

  /** A file that failed outside any test: a failing hook, an import error, a collection error. */
  onTestModuleEnd(testModule) {
    this.print(`${relative(this.root, testModule.moduleId)} (file)`, testModule.moduleId, testModule.errors());
  }
}
