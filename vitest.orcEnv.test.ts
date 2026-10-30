import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Captured before any test can stub the environment: what this test process inherited.
const INHERITED_ORC_NAMES = Object.keys(process.env).filter((name) => name.startsWith('ORC_')).sort();

const REPO_ROOT = import.meta.dirname;
const CONFIGS = ['vitest.config.mjs', 'vitest.e2e.config.mjs', 'vitest.integration.config.mjs', 'vitest.real-providers.config.mjs'];
const SENTINEL = '/nonexistent/live-orc-session';

// Loads a config the way vitest does (in the parent, before test workers start),
// applies its deliberate test env as a worker would, then resolves lib/paths.ts.
const PROBE = `
const config = (await import(process.argv[1])).default;
Object.assign(process.env, config.test.env ?? {});
const paths = await import(process.argv[2]);
const orcEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('ORC_')));
console.log(JSON.stringify({ orcEnv, deliberate: config.test.env ?? {}, stateDir: paths.STATE_DIR, targetRepoRoot: paths.TARGET_REPO_ROOT }));
`;

describe('vitest configs strip inherited ORC_* variables', () => {
  it('this test process inherited only the config\'s deliberate ORC_* values', () => {
    expect(INHERITED_ORC_NAMES).toEqual(['ORC_DATA_HOME', 'ORC_SESSION_TRANSPORT']);
  });

  it.each(CONFIGS)('%s hides a live session\'s ORC_* environment from tests', async (config) => {
    const home = mkdtempSync(join(tmpdir(), 'orc-env-guard-'));
    try {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        // A real registry must not be consulted when a config pins no data home.
        HOME: home,
        XDG_DATA_HOME: home,
        ORC_STATE_DIR: `${SENTINEL}/state`,
        ORC_CONTROL_SOCKET: `${SENTINEL}/control.sock`,
        ORC_REPO_ROOT: `${SENTINEL}/repo`,
        ORC_PROJECT_ID: 'live-project',
        ORC_SESSION_SECRET: 'live-secret',
        ORC_SOME_FUTURE_VARIABLE: SENTINEL,
      };
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--input-type=module', '-e', PROBE,
        pathToFileURL(resolve(REPO_ROOT, config)).href,
        pathToFileURL(resolve(REPO_ROOT, 'lib', 'paths.ts')).href,
      ], { cwd: REPO_ROOT, env });
      const probe = JSON.parse(stdout.trim().split('\n').at(-1)!);
      expect(probe.orcEnv).toEqual(probe.deliberate);
      expect(JSON.stringify(probe.orcEnv)).not.toContain(SENTINEL);
      expect(probe.stateDir).not.toContain(SENTINEL);
      expect(probe.targetRepoRoot).not.toContain(SENTINEL);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
