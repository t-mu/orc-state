import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectBareModuleSpecifiers,
  findUndeclaredRuntimeDependencies,
  parsePackFilename,
} from './pack-smoke.ts';

describe('scripts/pack-smoke.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses npm pack json output', () => {
    const output = '[\n  {\n    "filename": "orc-state-0.1.0.tgz"\n  }\n]\n';
    expect(parsePackFilename(output)).toBe('orc-state-0.1.0.tgz');
  });

  it('collects bare runtime specifiers only', () => {
    const source = `
      import chalk from 'chalk';
      import('./lazy.js');
      import('@scope/pkg/subpath');
      import localThing from './local.js';
      const pty = require('node-pty');
      const ignored = require('../relative.cjs');
    `;
    expect(collectBareModuleSpecifiers(source).sort()).toEqual(['@scope/pkg/subpath', 'chalk', 'node-pty']);
  });

  it('flags undeclared runtime dependencies in dist output', () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-smoke-test-'));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.js'), "import chalk from 'chalk';\nimport { readFileSync } from 'node:fs';\n");
    writeFileSync(join(root, 'dist', 'worker.js'), "const pty = require('node-pty');\n");

    const missing = findUndeclaredRuntimeDependencies(root, {
      name: 'orc-state',
      dependencies: { chalk: '5.4.1' },
    });

    expect(missing).toEqual(['node-pty']);
  });
});
