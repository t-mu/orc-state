#!/usr/bin/env node
import { stdin as input, stdout as output } from 'node:process';

export type ReleaseCategory = 'added' | 'changed' | 'fixed' | 'other';

const EXCLUDED_COMMIT_PATTERNS = [
  /^mark task done$/,
  /^chore\(backlog\):\s+/,
  /^chore\(release\):\s+/,
];

export function shouldIncludeReleaseCommit(subject: string): boolean {
  return !EXCLUDED_COMMIT_PATTERNS.some((pattern) => pattern.test(subject));
}

export function classifyReleaseCommit(subject: string): ReleaseCategory {
  const prefix = subject.split(':', 1)[0]?.replace(/\(.*/, '') ?? subject;
  switch (prefix) {
    case 'feat':
      return 'added';
    case 'fix':
      return 'fixed';
    case 'refactor':
    case 'chore':
    case 'docs':
    case 'test':
      return 'changed';
    default:
      return 'other';
  }
}

export function extractReleaseSummary(subject: string): string {
  return subject.includes(': ') ? subject.slice(subject.indexOf(': ') + 2) : subject;
}

export function groupReleaseCommits(subjects: string[]): Record<ReleaseCategory, string[]> {
  const grouped: Record<ReleaseCategory, string[]> = {
    added: [],
    changed: [],
    fixed: [],
    other: [],
  };

  for (const subject of subjects) {
    if (!shouldIncludeReleaseCommit(subject)) continue;
    grouped[classifyReleaseCommit(subject)].push(extractReleaseSummary(subject));
  }

  return grouped;
}

export function renderReleaseSection(
  version: string,
  date: string,
  subjects: string[],
): string {
  const grouped = groupReleaseCommits(subjects);
  let section = `## [${version}] - ${date}\n\n`;

  if (grouped.added.length > 0) {
    section += `### Added\n\n${grouped.added.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  if (grouped.changed.length > 0) {
    section += `### Changed\n\n${grouped.changed.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  if (grouped.fixed.length > 0) {
    section += `### Fixed\n\n${grouped.fixed.map((item) => `- ${item}`).join('\n')}\n\n`;
  }
  if (grouped.other.length > 0) {
    section += `### Other\n\n${grouped.other.map((item) => `- ${item}`).join('\n')}\n\n`;
  }

  return section;
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += String(chunk);
  }
  return text;
}

function flag(name: string): string | null {
  const entry = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return entry ? entry.slice(name.length + 3) : null;
}

async function main(): Promise<void> {
  const version = flag('version');
  const date = flag('date');
  if (!version || !date) {
    console.error('usage: node scripts/release-notes.ts --version=<x.y.z> --date=<YYYY-MM-DD>');
    process.exitCode = 1;
    return;
  }

  const stdinText = await readStdin();
  const subjects = stdinText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  output.write(renderReleaseSection(version, date, subjects));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
