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
    expect(sessionForCredential(dir, 'secret-a')?.session_id).toBe('session-a');
    expect(sessionForCredential(dir, 'session-a')).toBeNull();
    expect(sessionForCredential(dir, 'session-old')).toBeNull();
    expect(sessionForCredential(dir, credentialHash('secret-a'))).toBeNull();
    expect(sessionForCredential(dir, '')).toBeNull();
  });

  it('a legacy installation also accepts the id of a session recorded without a secret', () => {
    expect(sessionForCredential(dir, 'secret-a')?.session_id).toBe('session-a');
    expect(sessionForCredential(dir, 'session-old')?.session_id).toBe('session-old');
    // A session that has a secret is never proven by its id, and imported ids never authenticate.
    expect(sessionForCredential(dir, 'session-a')).toBeNull();
    expect(sessionForCredential(dir, 'legacy-worker-c')).toBeNull();
  });

  it('clients present the master\'s secret, else the session\'s own', () => {
    expect(clientCredential({ ORC_MASTER_SECRET: 'm', ORC_SESSION_SECRET: 's' })).toBe('m');
    expect(clientCredential({ ORC_MASTER_SECRET: '', ORC_SESSION_SECRET: 's' })).toBe('s');
    expect(clientCredential({ ORC_SESSION_TOKEN: 'session-a' })).toBeNull();
  });

  it('a relaunch of the same session keeps its hash unless it brings a new one', async () => {
    const { recordProviderSession } = await import('./runStore.ts');
    const record = (credential: string | null) => recordProviderSession(dir, {
      sessionId: 'session-z', runId: null, agentId: 'worker-z', provider: 'claude', providerRef: null,
      startedAt: new Date().toISOString(), credentialHash: credential === null ? null : credentialHash(credential),
    });
    record('secret-z');
    record(null);
    expect(sessionForCredential(dir, 'secret-z')?.session_id).toBe('session-z');
    record('secret-z2');
    expect(sessionForCredential(dir, 'secret-z')).toBeNull();
    expect(sessionForCredential(dir, 'secret-z2')?.session_id).toBe('session-z');
  });

  it('ignores a master secret reference the provider did not expand', () => {
    expect(clientCredential({ ORC_MASTER_SECRET: '${ORC_MASTER_SECRET}', ORC_SESSION_SECRET: 's' })).toBe('s');
    expect(clientCredential({ ORC_MASTER_SECRET: '${ORC_MASTER_SECRET}' })).toBeNull();
  });
});
