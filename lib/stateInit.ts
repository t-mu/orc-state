import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { initEventsDb } from './eventLog.ts';

/**
 * Idempotently initialise the orchestrator state directory.
 * Creates the directory and writes default state files only if they do not
 * already exist. Safe to call on a repo that already has state in place.
 */
export function ensureStateInitialized(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(join(stateDir, 'backlog.json'))) {
    atomicWriteJson(join(stateDir, 'backlog.json'), {
      version: '1',
      features: [{ ref: 'project', title: 'Project', tasks: [] }],
    });
  }
  if (!existsSync(join(stateDir, 'agents.json'))) {
    atomicWriteJson(join(stateDir, 'agents.json'), { version: '1', agents: [] });
  }
  if (!existsSync(join(stateDir, 'claims.json'))) {
    atomicWriteJson(join(stateDir, 'claims.json'), { version: '1', claims: [] });
  }
  initEventsDb(stateDir);
}
