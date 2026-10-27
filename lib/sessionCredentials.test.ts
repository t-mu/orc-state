import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from './eventLog.ts';
import { clientCredential, credentialHash, newSessionSecret, sessionForCredential } from './sessionCredentials.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-credentials-');
  seedState(dir);
  initEventsDb(dir);
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at, credential_hash)
      VALUES ('session-a', NULL, 'worker-a', 'claude', 'running', 'now', 'now', ?),
        ('session-old', NULL, 'worker-b', 'claude', 'running', 'now', 'now', NULL),
        ('legacy-worker-c', NULL, 'worker-c', 'claude', 'running', 'now', 'now', NULL)`).run(credentialHash('secret-a'));
  });
});

afterEach(() => {
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('session credentials (task 231)', () => {
  it('generates distinct secrets and stores only their hash', () => {
    const secret = newSessionSecret();
    expect(secret).not.toBe(newSessionSecret());
    expect(secret.length).toBeGreaterThanOrEqual(43);
    expect(credentialHash(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialHash(secret)).not.toContain(secret);
  });

  it('a project accepts a session secret and nothing read from the state', () => {
    writeFileSync(join(dir, 'runtime.db'), '');
    expect(sessionForCredential(dir, 'secret-a')).toBe('session-a');
    expect(sessionForCredential(dir, 'session-a')).toBeNull();
    expect(sessionForCredential(dir, 'session-old')).toBeNull();
    expect(sessionForCredential(dir, credentialHash('secret-a'))).toBeNull();
    expect(sessionForCredential(dir, '')).toBeNull();
  });

  it('a legacy installation also accepts the id of a session recorded without a secret', () => {
    expect(sessionForCredential(dir, 'secret-a')).toBe('session-a');
    expect(sessionForCredential(dir, 'session-old')).toBe('session-old');
    // A session that has a secret is never proven by its id, and imported ids never authenticate.
    expect(sessionForCredential(dir, 'session-a')).toBeNull();
    expect(sessionForCredential(dir, 'legacy-worker-c')).toBeNull();
  });

  it('clients present the master\'s secret, else the session\'s own', () => {
    expect(clientCredential({ ORC_MASTER_SECRET: 'm', ORC_SESSION_SECRET: 's' })).toBe('m');
    expect(clientCredential({ ORC_MASTER_SECRET: '', ORC_SESSION_SECRET: 's' })).toBe('s');
    expect(clientCredential({ ORC_SESSION_TOKEN: 'session-a' })).toBeNull();
  });
});
