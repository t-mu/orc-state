import { mkdirSync, writeFileSync, writeSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import {
  parsePlan,
  findPlanById,
  nextPlanId,
  PlanValidationError,
  PlanLookupError,
} from './planDocs.ts';

let plansDir: string;

function plan({
  planId = 1,
  name = 'sample',
  title = 'Sample Plan',
  createdAt = '2026-04-16T00:00:00Z',
  updatedAt = '2026-04-16T00:00:00Z',
  derivedTaskRefs = '[]',
  body,
}: {
  planId?: number;
  name?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  derivedTaskRefs?: string;
  body?: string;
} = {}): string {
  const defaultBody = `# ${title}

## Objective

Ship the sample.

## Scope

- Outcome A.

## Out of Scope

- Thing B.

## Constraints

- Keep API stable.

## Affected Areas

- lib/foo.ts

## Implementation Steps

### Step 1 — First step

Do the first thing.

### Step 2 — Second step

Do the second thing.

Depends on: 1
`;
  return `---
plan_id: ${planId}
name: ${name}
title: ${title}
created_at: ${createdAt}
updated_at: ${updatedAt}
derived_task_refs: ${derivedTaskRefs}
---

${body ?? defaultBody}`;
}

function writePlan(filename: string, content: string): string {
  const path = join(plansDir, filename);
  writeFileSync(path, content, 'utf8');
  return path;
}

beforeEach(() => {
  plansDir = createTempStateDir('plan-docs-');
});

afterEach(() => {
  cleanupTempStateDir(plansDir);
});

describe('parsePlan', () => {
  it('parses a valid plan artifact with derived_task_refs: []', () => {
    const path = writePlan('1-sample.md', plan());
    const parsed = parsePlan(path);
    expect(parsed.planId).toBe(1);
    expect(parsed.name).toBe('sample');
    expect(parsed.title).toBe('Sample Plan');
    expect(parsed.derivedTaskRefs).toEqual([]);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]).toMatchObject({ number: 1, title: 'First step', dependsOn: [] });
    expect(parsed.steps[1]).toMatchObject({ number: 2, title: 'Second step', dependsOn: [1] });
    expect(parsed.objective).toContain('Ship the sample.');
  });

  it('parses derived_task_refs as an inline list', () => {
    const path = writePlan(
      '2-with-refs.md',
      plan({ planId: 2, derivedTaskRefs: '[lifecycle-verbs/10-a, lifecycle-verbs/11-b]' }),
    );
    expect(parsePlan(path).derivedTaskRefs).toEqual([
      'lifecycle-verbs/10-a',
      'lifecycle-verbs/11-b',
    ]);
  });

  it('parses derived_task_refs as a multi-line YAML list', () => {
    const content = plan({ derivedTaskRefs: '\n  - foo/1-a\n  - foo/2-b' });
    const path = writePlan('3-multi.md', content);
    expect(parsePlan(path).derivedTaskRefs).toEqual(['foo/1-a', 'foo/2-b']);
  });

  it('rejects missing required frontmatter field', () => {
    const content = `---
plan_id: 4
name: sample
title: Sample
created_at: 2026-04-16T00:00:00Z
updated_at: 2026-04-16T00:00:00Z
---

# Sample Plan

## Objective
A

## Scope
A

## Out of Scope
A

## Constraints
A

## Affected Areas
A

## Implementation Steps

### Step 1 — a
x
`;
    const path = writePlan('4-missing.md', content);
    expect(() => parsePlan(path)).toThrow(PlanValidationError);
    expect(() => parsePlan(path)).toThrow(/derived_task_refs/);
  });

  it('rejects missing required section', () => {
    const body = `# Sample Plan

## Objective

A

## Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

x
`;
    const path = writePlan('5-no-out-of-scope.md', plan({ planId: 5, body }));
    expect(() => parsePlan(path)).toThrow(/Out of Scope/);
  });

  it('rejects malformed Implementation Steps heading', () => {
    const body = `# Sample Plan

## Objective

A

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Not a step heading

x
`;
    const path = writePlan('6-bad-step.md', plan({ planId: 6, body }));
    expect(() => parsePlan(path)).toThrow(/Malformed implementation step heading/);
  });

  it('rejects placeholder: TBD', () => {
    const body = `# T

## Objective

TBD

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

x
`;
    const path = writePlan('7-tbd.md', plan({ planId: 7, body }));
    expect(() => parsePlan(path)).toThrow(/TBD/);
  });

  it('rejects placeholder: TODO', () => {
    const body = `# T

## Objective

TODO finish this later

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

x
`;
    const path = writePlan('8-todo.md', plan({ planId: 8, body }));
    expect(() => parsePlan(path)).toThrow(/TODO/);
  });

  it('rejects placeholder: ??? (three or more question marks)', () => {
    const body = `# T

## Objective

What about ????

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

x
`;
    const path = writePlan('9-qm.md', plan({ planId: 9, body }));
    expect(() => parsePlan(path)).toThrow(/\?\?\?/);
  });

  it('rejects bracketed placeholders outside code blocks and links', () => {
    const body = `# T

## Objective

Answer is [fill this in]

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

x
`;
    const path = writePlan('10-bracket.md', plan({ planId: 10, body }));
    expect(() => parsePlan(path)).toThrow(/bracketed placeholder/);
  });

  it('accepts bracketed text inside fenced code blocks and markdown links', () => {
    const body = `# T

## Objective

See [the docs](https://example.com/docs) for details.

\`\`\`ts
const x: string[] = [];
const y = [1, 2, 3];
\`\`\`

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

Reference [another link](./foo.md) here.
`;
    const path = writePlan('11-ok-brackets.md', plan({ planId: 11, body }));
    const parsed = parsePlan(path);
    expect(parsed.planId).toBe(11);
  });

  it('rejects malformed explicit dependency cues', () => {
    const body = `# T

## Objective

A

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

x

### Step 2 — b

Depends on: step one
`;
    const path = writePlan('12-bad-deps.md', plan({ planId: 12, body }));
    expect(() => parsePlan(path)).toThrow(/Malformed dependency cue/);
  });

  it('parses multiple dependencies in exact Depends on: N, M form', () => {
    const body = `# T

## Objective

A

## Scope

A

## Out of Scope

A

## Constraints

A

## Affected Areas

A

## Implementation Steps

### Step 1 — a

x

### Step 2 — b

x

### Step 3 — c

Depends on: 1, 2
`;
    const path = writePlan('13-multi-deps.md', plan({ planId: 13, body }));
    const parsed = parsePlan(path);
    expect(parsed.steps[2].dependsOn).toEqual([1, 2]);
  });

  it('rejects a BOM-prefixed plan file', () => {
    const path = join(plansDir, '14-bom.md');
    const fd = openSync(path, 'w');
    try {
      writeSync(fd, Buffer.from([0xef, 0xbb, 0xbf]));
      writeSync(fd, plan({ planId: 14 }));
    } finally {
      closeSync(fd);
    }
    expect(() => parsePlan(path)).toThrow(/BOM/);
  });

  it('rejects a non-UTF-8 plan file', () => {
    const path = join(plansDir, '15-bad-bytes.md');
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00, 0x00]));
    expect(() => parsePlan(path)).toThrow(/not valid UTF-8/);
  });
});

describe('findPlanById', () => {
  it('resolves a single matching plan file', () => {
    writePlan('3-only-one.md', plan({ planId: 3 }));
    const resolved = findPlanById(3, plansDir);
    expect(resolved).toBe(join(plansDir, '3-only-one.md'));
  });

  it('fails when lookup finds no matches', () => {
    mkdirSync(plansDir, { recursive: true });
    writePlan('1-other.md', plan({ planId: 1 }));
    expect(() => findPlanById(42, plansDir)).toThrow(PlanLookupError);
    expect(() => findPlanById(42, plansDir)).toThrow(/No plan found/);
  });

  it('fails when lookup finds multiple matches', () => {
    writePlan('7-first.md', plan({ planId: 7 }));
    writePlan('7-second.md', plan({ planId: 7, name: 'second' }));
    expect(() => findPlanById(7, plansDir)).toThrow(/Duplicate plans/);
  });
});

describe('nextPlanId', () => {
  it('returns 1 when the directory is empty or missing', async () => {
    const missing = join(plansDir, 'nested');
    expect(await nextPlanId(missing)).toBe(1);
  });

  it('returns max+1 on a populated directory', async () => {
    writePlan('5-foo.md', plan({ planId: 5 }));
    writePlan('7-bar.md', plan({ planId: 7 }));
    expect(await nextPlanId(plansDir)).toBe(8);
  });

  it('allocates the next plan id atomically under concurrent callers', async () => {
    writePlan('4-foo.md', plan({ planId: 4 }));
    const results = await Promise.all([
      nextPlanId(plansDir),
      nextPlanId(plansDir),
      nextPlanId(plansDir),
    ]);
    const unique = new Set(results);
    expect(unique.size).toBe(3);
    for (const id of results) expect(id).toBeGreaterThan(4);
  });
});
