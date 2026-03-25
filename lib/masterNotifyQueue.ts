import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './lock.ts';

const QUEUE_FILE = 'master-notify-queue.jsonl';

export interface QueueEntry {
  seq: number;
  consumed: boolean;
  [key: string]: unknown;
}

function queuePath(stateDir: string): string {
  return join(stateDir, QUEUE_FILE);
}

function parseJsonLine(line: string): QueueEntry | null {
  try {
    return JSON.parse(line) as QueueEntry;
  } catch {
    return null;
  }
}

function readQueueLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  if (!content.trim()) return [];
  return content.split('\n').filter(Boolean);
}

function computeNextSeq(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseJsonLine(lines[i]);
    if (parsed && Number.isInteger(parsed.seq) && parsed.seq >= 1) {
      return parsed.seq + 1;
    }
  }
  return 1;
}

function hasDedupeKey(lines: string[], dedupeKey: unknown): boolean {
  if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) return false;
  return lines.some((line) => parseJsonLine(line)?.dedupe_key === dedupeKey);
}

export function appendNotification(stateDir: string, notification: Record<string, unknown>): boolean {
  const lockPath = join(stateDir, '.lock');
  try {
    withLock(lockPath, () => {
      const path = queuePath(stateDir);
      const lines = readQueueLines(path);
      if (hasDedupeKey(lines, notification.dedupe_key)) {
        return;
      }
      const nextSeq = computeNextSeq(lines);
      const entry: QueueEntry = { seq: nextSeq, consumed: false, ts: new Date().toISOString(), ...notification };
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    });
    return true;
  } catch (error) {
    console.error(
      `[master-notify-queue] append failed: ${(error as Error)?.message ?? 'unknown error'}`,
    );
    return false;
  }
}

export function readPendingNotifications(stateDir: string): QueueEntry[] {
  const path = queuePath(stateDir);
  if (!existsSync(path)) return [];
  const lines = readQueueLines(path);
  return lines
    .map(parseJsonLine)
    .filter((entry): entry is QueueEntry => entry !== null && entry.consumed !== true);
}

export function markConsumed(stateDir: string, seqs: unknown[]): void {
  const lockPath = join(stateDir, '.lock');
  try {
    withLock(lockPath, () => {
      const path = queuePath(stateDir);
      if (!existsSync(path)) return;

      const seqSet = new Set<number>(
        (Array.isArray(seqs) ? seqs : [])
          .filter((seq): seq is number => Number.isInteger(seq)),
      );
      if (seqSet.size === 0) return;

      const lines = readQueueLines(path);
      const rewritten = lines.map((line) => {
        const parsed = parseJsonLine(line);
        if (!parsed || !Number.isInteger(parsed.seq)) return line;
        if (!seqSet.has(parsed.seq)) return line;
        return JSON.stringify({ ...parsed, consumed: true });
      });

      const output = rewritten.length > 0 ? `${rewritten.join('\n')}\n` : '';
      writeFileSync(path, output, 'utf8');
    });
  } catch (error) {
    console.error(
      `[master-notify-queue] markConsumed failed: ${(error as Error)?.message ?? 'unknown error'}`,
    );
  }
}

export function readAndMarkConsumed(stateDir: string): QueueEntry[] {
  const lockPath = join(stateDir, '.lock');
  try {
    return withLock(lockPath, () => {
      const path = queuePath(stateDir);
      if (!existsSync(path)) return [];

      const lines = readQueueLines(path);
      const pending = lines
        .map(parseJsonLine)
        .filter((entry): entry is QueueEntry => entry !== null && entry.consumed !== true);
      if (pending.length === 0) return [];

      const seqSet = new Set<number>(
        pending
          .map((entry) => entry.seq)
          .filter((seq): seq is number => Number.isInteger(seq)),
      );
      const rewritten = lines.map((line) => {
        const parsed = parseJsonLine(line);
        if (!parsed || !Number.isInteger(parsed.seq)) return line;
        if (!seqSet.has(parsed.seq)) return line;
        return JSON.stringify({ ...parsed, consumed: true });
      });

      const output = rewritten.length > 0 ? `${rewritten.join('\n')}\n` : '';
      writeFileSync(path, output, 'utf8');
      return pending;
    });
  } catch (error) {
    console.error(
      `[master-notify-queue] readAndMarkConsumed failed: ${(error as Error)?.message ?? 'unknown error'}`,
    );
    return [];
  }
}

export function clearNotifications(stateDir: string, olderThanMs?: number): number {
  const lockPath = join(stateDir, '.lock');
  try {
    return withLock(lockPath, () => {
      const path = queuePath(stateDir);
      if (!existsSync(path)) return 0;

      const nowMs = Date.now();
      const lines = readQueueLines(path);
      let cleared = 0;
      const rewritten = lines.map((line) => {
        const parsed = parseJsonLine(line);
        if (!parsed || parsed.consumed === true) return line;

        if (olderThanMs !== undefined) {
          const ts = typeof parsed.ts === 'string' ? parsed.ts : null;
          const entryMs = ts ? new Date(ts).getTime() : null;
          const isOldEnough = entryMs == null || Number.isNaN(entryMs) || (nowMs - entryMs) >= olderThanMs;
          if (!isOldEnough) return line;
        }

        cleared += 1;
        return JSON.stringify({ ...parsed, consumed: true });
      });

      if (cleared > 0) {
        const output = rewritten.length > 0 ? `${rewritten.join('\n')}\n` : '';
        writeFileSync(path, output, 'utf8');
      }
      return cleared;
    });
  } catch (error) {
    console.error(
      `[master-notify-queue] clearNotifications failed: ${(error as Error)?.message ?? 'unknown error'}`,
    );
    return 0;
  }
}

export function compactQueue(stateDir: string): void {
  const lockPath = join(stateDir, '.lock');
  try {
    withLock(lockPath, () => {
      const path = queuePath(stateDir);
      if (!existsSync(path)) return;

      const lines = readQueueLines(path);
      const compacted = lines.filter((line) => {
        const parsed = parseJsonLine(line);
        if (!parsed) return true;
        return parsed.consumed !== true;
      });
      if (compacted.length === lines.length) return;

      const output = compacted.length > 0 ? `${compacted.join('\n')}\n` : '';
      writeFileSync(path, output, 'utf8');
    });
  } catch (error) {
    console.error(
      `[master-notify-queue] compactQueue failed: ${(error as Error)?.message ?? 'unknown error'}`,
    );
  }
}
