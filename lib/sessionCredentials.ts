import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { withEventDb } from './eventLog.ts';
import { readProjectDescriptor } from './projectContext.ts';

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

export interface CredentialSession { session_id: string; agent_id: string; run_id: string | null; state: string }

const SESSION_COLUMNS = 'session_id, agent_id, run_id, state';

/**
 * The session a presented credential proves, or null. A project state
 * directory accepts only a session secret. A legacy installation also accepts
 * the session id of a session recorded without one (its sessions predate
 * secrets), never an imported `legacy-` id derived from a public name.
 */
export function resolveSessionCredential(db: Database.Database, credential: string, { secretsOnly }: { secretsOnly: boolean }): CredentialSession | null {
  if (!credential) return null;
  const bySecret = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE credential_hash = ?`).get(credentialHash(credential)) as CredentialSession | undefined;
  if (bySecret) return bySecret;
  if (secretsOnly || credential.startsWith('legacy-')) return null;
  return (db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ? AND credential_hash IS NULL`).get(credential) as CredentialSession | undefined) ?? null;
}

/**
 * The credential a client presents: the master's secret for its tools and
 * shells, else the session's own. A provider that did not expand an MCP
 * config's `${ORC_MASTER_SECRET}` reference passes the literal through; that is
 * no credential.
 */
export function clientCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const value of [env.ORC_MASTER_SECRET, env.ORC_SESSION_SECRET]) {
    const trimmed = value?.trim();
    if (trimmed && !trimmed.startsWith('${')) return trimmed;
  }
  return null;
}

/**
 * A project state directory accepts secrets only. It is recognised by its
 * project descriptor or its task store, so losing one of them does not make
 * it accept readable session ids.
 */
function secretsOnly(stateDir: string): boolean {
  return existsSync(join(stateDir, 'runtime.db')) || readProjectDescriptor(stateDir) !== null;
}

/** resolveSessionCredential against a state directory's event store. */
export function sessionForCredential(stateDir: string, credential: string): CredentialSession | null {
  const only = secretsOnly(stateDir);
  return withEventDb(stateDir, (db) => resolveSessionCredential(db, credential, { secretsOnly: only }));
}
