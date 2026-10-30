import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { initEventsDb } from './eventLog.ts';
import { initMemoryDb } from './memoryStore.ts';
import { initProjectTaskStore, refreshBacklogProjection } from './projectTasks.ts';

/**
 * Idempotently initialise a project's state directory: its task store, the
 * agent and claim files, and the event and memory databases. Writes default
 * files only where none exist, so it is safe on a directory already in use.
 * backlog.json is the task store's projection, written from it (the
 * coordinator and doctor expect the file before the first task changes).
 */
export function ensureStateInitialized(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  initProjectTaskStore(stateDir);
  if (!existsSync(join(stateDir, 'backlog.json'))) refreshBacklogProjection(stateDir);
  if (!existsSync(join(stateDir, 'agents.json'))) {
    atomicWriteJson(join(stateDir, 'agents.json'), { version: '1', agents: [] });
  }
  if (!existsSync(join(stateDir, 'claims.json'))) {
    atomicWriteJson(join(stateDir, 'claims.json'), { version: '1', claims: [] });
  }
  initEventsDb(stateDir);
  initMemoryDb(stateDir);
}
