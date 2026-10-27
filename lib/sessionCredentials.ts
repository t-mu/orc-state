import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { withEventDb } from './eventLog.ts';

/**
 * Per-session secrets (task 231). Each launched session — worker, scout,
 * master — gets a random secret that only its own process holds: it is
 * delivered in the environment (ORC_SESSION_SECRET, or ORC_MASTER_SECRET for
 * the master's tools) and never written to the state directory, PTY logs, the
 * bootstrap or events. The `sessions` table keeps only its hash, so a session
 * id read from the state authenticates nobody.
 */
export function newSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function credentialHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * The session a presented credential proves, or null. A project state
 * directory accepts only a session secret. A legacy installation also accepts
 * the session id of a session recorded without one (its sessions predate
 * secrets), never an imported `legacy-` id derived from a public name.
 */
export function resolveSessionCredential(db: Database.Database, credential: string, { secretsOnly }: { secretsOnly: boolean }): string | null {
  if (!credential) return null;
  const bySecret = db.prepare('SELECT session_id FROM sessions WHERE credential_hash = ?').get(credentialHash(credential)) as { session_id: string } | undefined;
  if (bySecret) return bySecret.session_id;
  if (secretsOnly || credential.startsWith('legacy-')) return null;
  const byId = db.prepare('SELECT session_id FROM sessions WHERE session_id = ? AND credential_hash IS NULL').get(credential) as { session_id: string } | undefined;
  return byId?.session_id ?? null;
}

/** The credential a client presents: the master's secret for its tools and shells, else the session's own. */
export function clientCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ORC_MASTER_SECRET?.trim() || env.ORC_SESSION_SECRET?.trim() || null;
}

/** resolveSessionCredential against a state directory's event store. */
export function sessionForCredential(stateDir: string, credential: string): string | null {
  const secretsOnly = existsSync(join(stateDir, 'runtime.db'));
  return withEventDb(stateDir, (db) => resolveSessionCredential(db, credential, { secretsOnly }));
}
