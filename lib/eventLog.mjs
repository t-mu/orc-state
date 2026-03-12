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
import { withLock } from './lock.mjs';
import { validateEventObject } from './eventValidation.mjs';

const MAX_EVENTS_LOG_LINES = 10_000;
const MAX_EVENTS_LOG_BYTES = 5 * 1024 * 1024;

function archivePaths(logPath) {
  return [`${logPath}.1`, `${logPath}.2`];
}

function parseJsonLineOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseNonEmptyLines(content) {
  return content.split('\n').filter((line) => line.trim().length > 0);
}

function countNonEmptyLines(content) {
  return parseNonEmptyLines(content).length;
}

function lastSeqInBuffer(buf) {
  if (!buf || buf.length === 0) return null;

  let end = buf.length - 1;
  while (end >= 0 && (buf[end] === 0x0a || buf[end] === 0x0d)) end--;

  while (end >= 0) {
    let start = end;
    while (start > 0 && buf[start - 1] !== 0x0a) start--;
    const line = buf.slice(start, end + 1).toString('utf8').trim();
    if (line) {
      try {
        const parsed = JSON.parse(line);
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
  logPath,
  { maxLines = MAX_EVENTS_LOG_LINES, maxBytes = MAX_EVENTS_LOG_BYTES } = {},
) {
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
export function appendEvent(logPath, event, { fsyncPolicy = 'always' } = {}) {
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
  stateDir,
  event,
  { fsyncPolicy = 'always', lockAlreadyHeld = false } = {},
) {
  const logPath = join(stateDir, 'events.jsonl');
  const lockPath = join(stateDir, '.lock');

  const append = () => {
    rotateEventsLogIfNeeded(logPath);
    const seq = nextSeq(logPath);
    appendEvent(logPath, { ...event, seq }, { fsyncPolicy });
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
export function readEvents(logPath) {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      const validationErrors = validateEventObject(event);
      if (validationErrors.length > 0) {
        throw new Error(`events.jsonl schema error at line ${i + 1}: ${validationErrors.join('; ')}`);
      }
      events.push(event);
    } catch (error) {
      if (String(error.message ?? '').startsWith('events.jsonl schema error at line')) {
        throw error;
      }
      throw new Error(`events.jsonl parse error at line ${i + 1}: ${error.message}`);
    }
  }
  return events;
}

/**
 * Read events with seq strictly greater than afterSeq.
 * Returns an empty array if the file does not exist.
 * Silently skips malformed lines.
 */
export function readEventsSince(logPath, afterSeq) {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line);
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
export function readRecentEvents(logPath, limit = 50) {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative integer');
  }
  if (limit === 0) return [];

  const files = [`${logPath}.2`, `${logPath}.1`, logPath];
  const events = [];
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
export function nextSeq(logPath) {
  const files = [logPath, ...archivePaths(logPath)];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lastSeq = lastSeqInBuffer(readFileSync(file));
    if (typeof lastSeq === 'number') return lastSeq + 1;
  }
  return 1;
}
