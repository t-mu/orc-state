import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import * as client from './client.ts';

const ROOT = import.meta.dirname;

describe('client entry (client.ts)', () => {
  it('exports the client surface', () => {
    expect(Object.keys(client).sort()).toEqual([
      'CONTROL_PROTOCOL_VERSION',
      'ControlClient',
      'ControlError',
      'RegistrySchemaError',
      'listProjects',
    ]);
  });

  it('pulls in Node built-ins only: no native or heavy dependency and no project resolution', () => {
    const { metafile } = buildSync({
      entryPoints: [join(ROOT, 'client.ts')], bundle: true, write: false, metafile: true,
      platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    });
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.some((input) => input.endsWith('lib/paths.ts'))).toBe(false);
    expect(inputs.some((input) => input.endsWith('lib/projectRegistry.ts'))).toBe(false);
    const external = new Set(Object.values(metafile.outputs).flatMap((output) => output.imports.filter((i) => i.external).map((i) => i.path)));
    for (const name of ['better-sqlite3', 'ajv', 'ink', 'react']) expect(external.has(name), name).toBe(false);
    const builtins = new Set(builtinModules);
    for (const path of external) expect(path.startsWith('node:') || builtins.has(path), `${path} is not a Node built-in`).toBe(true);
  });

  it('imports with a bogus ORC_PROJECT_ID from / without git calls or file writes, and lists no projects', () => {
    const temp = mkdtempSync(join(tmpdir(), 'orc-client-entry-'));
    try {
      const bin = join(temp, 'bin');
      const marker = join(temp, 'git-called');
      const dataHome = join(temp, 'data');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      chmodSync(join(bin, 'git'), 0o755);
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', [
        `const m = await import(${JSON.stringify(join(ROOT, 'client.ts'))});`,
        'console.log(JSON.stringify(m.listProjects()));',
      ].join('\n')], {
        cwd: '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: temp, ORC_PROJECT_ID: 'bogus', ORC_DATA_HOME: dataHome, ORC_CONTROL_SOCKET: join(temp, 'x.sock') },
      });
      expect(JSON.parse(out)).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(temp).sort()).toEqual(['bin']);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
