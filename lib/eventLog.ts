import {
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  writeSync,
  existsSync,
  renameSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { withLock } from './lock.ts';
import { validateEventObject } from './eventValidation.ts';
import type { OrcEvent, OrcEventInput } from '../types/events.ts';

const MAX_EVENTS_LOG_LINES = 10_000;
const MAX_EVENTS_LOG_BYTES = 5 * 1024 * 1024;

function archivePaths(logPath: string): [string, string] {
  return [`${logPath}.1`, `${logPath}.2`];
}

function parseJsonLineOrNull(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseNonEmptyLines(content: string): string[] {
  return content.split('\n').filter((line) => line.trim().length > 0);
}

function countNonEmptyLines(content: string): number {
  return parseNonEmptyLines(content).length;
}

function lastSeqInBuffer(buf: Buffer | null | undefined): number | null {
  if (!buf || buf.length === 0) return null;

  let end = buf.length - 1;
  while (end >= 0 && (buf[end] === 0x0a || buf[end] === 0x0d)) end--;

  while (end >= 0) {
    let start = end;
    while (start > 0 && buf[start - 1] !== 0x0a) start--;
    const line = buf.slice(start, end + 1).toString('utf8').trim();
    if (line) {
      try {
        const parsed = JSON.parse(line) as { seq?: unknown };
        if (typeof parsed.seq === 'number') return parsed.seq;
      } catch { /* malformed line — keep scanning */ }
    }
    end = start - 1;
    while (end >= 0 && (buf[end] === 0x0a || buf[end] === 0x0d)) end--;
  }

  return null;
}

/**
 * Rotate events log when it exceeds configured thresholds.
 * Rotation strategy:
 *   - drop events.jsonl.2
 *   - shift events.jsonl.1 -> events.jsonl.2
 *   - rename events.jsonl   -> events.jsonl.1
 *   - create empty events.jsonl
 */
export function rotateEventsLogIfNeeded(
  logPath: string,
  { maxLines = MAX_EVENTS_LOG_LINES, maxBytes = MAX_EVENTS_LOG_BYTES } = {},
): boolean {
  if (!existsSync(logPath)) return false;

  const size = statSync(logPath).size;
  const content = readFileSync(logPath, 'utf8');
  const lineCount = countNonEmptyLines(content);
  if (size < maxBytes && lineCount < maxLines) return false;

  const [archive1, archive2] = archivePaths(logPath);
  if (existsSync(archive2)) unlinkSync(archive2);
  if (existsSync(archive1)) renameSync(archive1, archive2);
  renameSync(logPath, archive1);
  writeFileSync(logPath, '', 'utf8');
  return true;
}

/**
 * Append one event object as a single NDJSON line to logPath.
 *
 * fsyncPolicy:
 *   'always' (default) — fsync after every append for full durability.
 *   'never'            — skip fsync (faster; acceptable for low-stakes dev runs).
 */
export function appendEvent(logPath: string, event: OrcEvent, { fsyncPolicy = 'always' } = {}): void {
  const errors = validateEventObject(event);
  if (errors.length > 0) {
    throw new Error(`event validation failed: ${errors.join('; ')}`);
  }

  const line = JSON.stringify(event) + '\n';
  const fd = openSync(logPath, 'a');
  try {
    writeSync(fd, line, null, 'utf8');
    if (fsyncPolicy === 'always') {
      fsyncSync(fd);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Append an event with an allocated monotonic seq under the state lock.
 */
export function appendSequencedEvent(
  stateDir: string,
  event: OrcEventInput,
  { fsyncPolicy = 'always', lockAlreadyHeld = false } = {},
): number {
  const logPath = join(stateDir, 'events.jsonl');
  const lockPath = join(stateDir, '.lock');

  const append = (): number => {
    rotateEventsLogIfNeeded(logPath);
    const seq = nextSeq(logPath);
    appendEvent(logPath, { ...event, seq } as OrcEvent, { fsyncPolicy });
    return seq;
  };

  if (lockAlreadyHeld) {
    return append();
  }
  return withLock(lockPath, append);
}

/**
 * Read and parse all events from an NDJSON log file.
 * Returns an empty array if the file does not exist.
 * Silently skips blank lines.
 */
export function readEvents(logPath: string): OrcEvent[] {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const events: OrcEvent[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line) as OrcEvent;
      const validationErrors = validateEventObject(event);
      if (validationErrors.length > 0) {
        throw new Error(`events.jsonl schema error at line ${i + 1}: ${validationErrors.join('; ')}`);
      }
      events.push(event);
    } catch (error) {
      if (String((error as Error).message ?? '').startsWith('events.jsonl schema error at line')) {
        throw error;
      }
      throw new Error(`events.jsonl parse error at line ${i + 1}: ${(error as Error).message}`);
    }
  }
  return events;
}

/**
 * Read events with seq strictly greater than afterSeq.
 * Returns an empty array if the file does not exist.
 * Silently skips malformed lines.
 */
export function readEventsSince(logPath: string, afterSeq: number): unknown[] {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const events: unknown[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { seq?: unknown };
      if (typeof event?.seq === 'number' && event.seq > afterSeq) {
        events.push(event);
      }
    } catch {
      // Skip malformed lines for incremental reads.
    }
  }
  return events;
}

/**
 * Return recent events from current log plus up to two archives.
 * Order is oldest->newest before tailing.
 */
export function readRecentEvents(logPath: string, limit = 50): unknown[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative integer');
  }
  if (limit === 0) return [];

  const files = [`${logPath}.2`, `${logPath}.1`, logPath];
  const events: unknown[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    for (const line of parseNonEmptyLines(content)) {
      const parsed = parseJsonLineOrNull(line);
      if (parsed) events.push(parsed);
    }
  }
  return events.slice(-Math.min(limit, 200));
}

/**
 * Return the next sequence number to use when appending an event.
 * Returns 1 for an empty or missing log.
 * O(1) for valid files: reads only the last line.
 * Degrades to O(n) only when the last line is malformed — scans backwards
 * to find the most recent valid line rather than returning a colliding seq.
 */
export function nextSeq(logPath: string): number {
  const files = [logPath, ...archivePaths(logPath)];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lastSeq = lastSeqInBuffer(readFileSync(file));
    if (typeof lastSeq === 'number') return lastSeq + 1;
  }
  return 1;
}
