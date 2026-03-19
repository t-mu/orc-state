import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { withLock, lockPath } from './lock.ts';
import type { EventProcessingCheckpoint } from '../types/event-checkpoint.ts';

export const EVENT_CHECKPOINT_FILE = 'event-checkpoint.json';
const CHECKPOINT_VERSION: EventProcessingCheckpoint['version'] = '1';

function assertValidCheckpoint(data: unknown): asserts data is EventProcessingCheckpoint {
  const checkpoint = data as Partial<EventProcessingCheckpoint> | null;
  if (checkpoint?.version !== CHECKPOINT_VERSION) {
    throw new Error('event-checkpoint.json: version must be "1"');
  }
  if (!Number.isInteger(checkpoint.last_processed_seq) || (checkpoint.last_processed_seq ?? -1) < 0) {
    throw new Error('event-checkpoint.json: last_processed_seq must be a non-negative integer');
  }
  if (!Array.isArray(checkpoint.processed_event_ids) || checkpoint.processed_event_ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('event-checkpoint.json: processed_event_ids must be an array of non-empty strings');
  }
  if (typeof checkpoint.updated_at !== 'string' || !Number.isFinite(new Date(checkpoint.updated_at).getTime())) {
    throw new Error('event-checkpoint.json: updated_at must be an ISO date-time string');
  }
}

export function defaultEventCheckpoint(nowIso = new Date().toISOString()): EventProcessingCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    last_processed_seq: 0,
    processed_event_ids: [],
    updated_at: nowIso,
  };
}

export function readEventCheckpoint(stateDir: string): EventProcessingCheckpoint {
  const path = join(stateDir, EVENT_CHECKPOINT_FILE);
  if (!existsSync(path)) return defaultEventCheckpoint();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  assertValidCheckpoint(parsed);
  return parsed;
}

export function writeEventCheckpoint(stateDir: string, checkpoint: EventProcessingCheckpoint): EventProcessingCheckpoint {
  const path = join(stateDir, EVENT_CHECKPOINT_FILE);
  const nextCheckpoint: EventProcessingCheckpoint = {
    version: CHECKPOINT_VERSION,
    last_processed_seq: checkpoint.last_processed_seq,
    processed_event_ids: Array.from(new Set(checkpoint.processed_event_ids)),
    updated_at: checkpoint.updated_at,
  };

  withLock(lockPath(stateDir), () => {
    atomicWriteJson(path, nextCheckpoint);
  });

  return nextCheckpoint;
}

export function advanceEventCheckpoint(
  checkpoint: EventProcessingCheckpoint,
  eventId: string,
  seq: number,
  nowIso = new Date().toISOString(),
): EventProcessingCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    last_processed_seq: Math.max(checkpoint.last_processed_seq, seq),
    processed_event_ids: Array.from(new Set([...checkpoint.processed_event_ids, eventId])),
    updated_at: nowIso,
  };
}

export function pruneEventCheckpoint(
  checkpoint: EventProcessingCheckpoint,
  retainedEventIds: Iterable<string>,
  nowIso = new Date().toISOString(),
): EventProcessingCheckpoint {
  const retained = new Set(retainedEventIds);
  return {
    version: CHECKPOINT_VERSION,
    last_processed_seq: checkpoint.last_processed_seq,
    processed_event_ids: checkpoint.processed_event_ids.filter((id) => retained.has(id)),
    updated_at: nowIso,
  };
}

export function seedEventCheckpointFromEvents(
  processedEventIds: Iterable<string>,
  lastProcessedSeq: number,
  nowIso = new Date().toISOString(),
): EventProcessingCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    last_processed_seq: Math.max(0, lastProcessedSeq),
    processed_event_ids: Array.from(new Set(processedEventIds)),
    updated_at: nowIso,
  };
}
