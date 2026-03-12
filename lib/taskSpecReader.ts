import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKLOG_DOCS_DIR } from './paths.ts';

function normalizeHeading(text: string): string {
  return text.trim().toLowerCase();
}

function stripOptionalCommentBlocks(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

function collectSection(lines: string[], startIndex: number): string {
  const collected: string[] = [];
  const baseLevel = lines[startIndex].match(/^(#+)\s+/)?.[1].length ?? 0;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = /^(#+)\s+/.exec(line);
    if (headingMatch && headingMatch[1].length <= baseLevel) break;
    collected.push(line);
  }

  return collected.join('\n').trim();
}

interface MarkdownTaskSpec {
  path: string;
  content: string;
}

function readMarkdownTaskSpec(taskRef: string, docsDir: string = BACKLOG_DOCS_DIR): MarkdownTaskSpec | null {
  if (!existsSync(docsDir)) return null;
  for (const file of readdirSync(docsDir)) {
    if (!file.endsWith('.md')) continue;
    const path = join(docsDir, file);
    const content = readFileSync(path, 'utf8');
    const frontmatterRef = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1]
      ?.split('\n')
      .find((line) => line.trim().startsWith('ref:'))
      ?.replace(/^ref:\s*/, '')
      .trim();
    if (frontmatterRef === taskRef) {
      return { path, content };
    }
  }
  return null;
}

export interface TaskSpecSections {
  current_state: string;
  desired_state: string;
  start_here: string;
  verification: string;
}

export function parseTaskSpecSections(markdown: string): TaskSpecSections {
  const clean = stripOptionalCommentBlocks(markdown);
  const lines = clean.split('\n');
  const sections: TaskSpecSections = {
    current_state: '',
    desired_state: '',
    start_here: '',
    verification: '',
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#+)\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const heading = normalizeHeading(match[2]);
    if (heading === 'current state') {
      sections.current_state = collectSection(lines, index);
    } else if (heading === 'desired state') {
      sections.desired_state = collectSection(lines, index);
    } else if (heading === 'start here') {
      sections.start_here = collectSection(lines, index);
    } else if (heading === 'verification') {
      sections.verification = collectSection(lines, index);
    }
  }

  return sections;
}

export function readTaskSpecSections(taskRef: string, docsDir: string = BACKLOG_DOCS_DIR): TaskSpecSections & { source_path: string | null } {
  const spec = readMarkdownTaskSpec(taskRef, docsDir);
  if (!spec) {
    return {
      current_state: '',
      desired_state: '',
      start_here: '',
      verification: '',
      source_path: null,
    };
  }

  return {
    ...parseTaskSpecSections(spec.content),
    source_path: spec.path,
  };
}
