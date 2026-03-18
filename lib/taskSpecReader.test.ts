import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskSpecSections, readTaskSpecSections } from './taskSpecReader.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-task-spec-reader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseTaskSpecSections', () => {
  it('extracts richer task-spec sections from markdown', () => {
    const markdown = `
### Current state
Current state text.

### Desired state
Desired state text.

### Start here
- first/file.ts

## Verification
\`\`\`bash
npm test
\`\`\`
`;

    expect(parseTaskSpecSections(markdown)).toEqual({
      current_state: 'Current state text.',
      desired_state: 'Desired state text.',
      start_here: '- first/file.ts',
      verification: '```bash\nnpm test\n```',
    });
  });
});

describe('readTaskSpecSections', () => {
  it('loads markdown by frontmatter ref from docs/backlog', () => {
    const docsDir = join(dir, 'docs', 'backlog');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, '142-sample.md'), `---
ref: orch/task-142-sample
feature: orch
---

### Current state
Current state text.

### Desired state
Desired state text.

### Start here
- foo.mjs

## Verification
\`\`\`bash
npx vitest
\`\`\`
`);

    const result = readTaskSpecSections('orch/task-142-sample', docsDir);
    expect(result.current_state).toBe('Current state text.');
    expect(result.desired_state).toBe('Desired state text.');
    expect(result.start_here).toContain('foo.mjs');
    expect(result.verification).toContain('npx vitest');
    expect(result.source_path).toBe(join(docsDir, '142-sample.md'));
  });

  it('ignores embedded example frontmatter blocks later in the file', () => {
    const docsDir = join(dir, 'docs', 'backlog');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'wrong.md'), `# Example

\`\`\`md
---
ref: orch/task-142-sample
---
\`\`\`
`);
    writeFileSync(join(docsDir, 'right.md'), `---
ref: orch/task-142-sample
feature: orch
---

### Current state
Actual task.
`);

    const result = readTaskSpecSections('orch/task-142-sample', docsDir);
    expect(result.source_path).toBe(join(docsDir, 'right.md'));
    expect(result.current_state).toBe('Actual task.');
  });
});
