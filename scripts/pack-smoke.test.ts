import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectBareModuleSpecifiers,
  findUndeclaredRuntimeDependencies,
  parsePackFilename,
} from './pack-smoke.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('scripts/pack-smoke.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses npm pack json output', () => {
    const output = '[\n  {\n    "filename": "orc-state-0.1.0.tgz"\n  }\n]\n';
    expect(parsePackFilename(output)).toBe('orc-state-0.1.0.tgz');
  });

  it('rejects stdout contamination before the json payload', () => {
    const output = '[prepare] noisy\n[\n  {\n    "filename": "orc-state-0.1.0.tgz"\n  }\n]\n';
    expect(() => parsePackFilename(output)).toThrow();
  });

  it('collects bare runtime specifiers only', () => {
    const source = `
      import chalk from 'chalk';
      export { thing } from '@scope/pkg/subpath';
      import('./lazy.js');
      import localThing from './local.js';
      const pty = require('node-pty');
      const comment = "require('not-a-real-dep')";
      // import fake from 'also-not-real';
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

  it('runs the real pack smoke script successfully after a build', { timeout: 30000 }, () => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    const result = spawnSync(process.execPath, ['scripts/pack-smoke.ts'], {
      cwd: ROOT,
      env: { ...process.env, npm_config_cache: join(tmpdir(), 'orc-pack-smoke-test-cache') },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pack smoke ok');
  });

  it('excludes plan-to-tasks workspace and eval artifacts from the packed tarball', { timeout: 30000 }, () => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      env: { ...process.env, npm_config_cache: join(tmpdir(), 'orc-pack-manifest-test-cache') },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const manifest = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = manifest[0]?.files.map((file) => file.path) ?? [];

    expect(paths.some((path) => path.includes('plan-to-tasks-workspace'))).toBe(false);
    expect(paths.some((path) => path.includes('dist/skills/plan-to-tasks/evals/'))).toBe(false);
  });
});
