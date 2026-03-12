import { writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync, existsSync } from 'node:fs';

/**
 * Atomically write a JSON-serialisable object to filePath.
 *
 * Protocol:
 *   1. Serialise to JSON and write to <filePath>.tmp
 *   2. fsync the temp file to flush OS buffers to disk
 *   3. rename() to replace the target — atomic on POSIX filesystems
 *
 * If any step fails the .tmp file is cleaned up and the original is untouched.
 */
export function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(data, null, 2) + '\n';

  try {
    writeFileSync(tmpPath, content, 'utf8');

    const fd = openSync(tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmpPath, filePath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
    }
    throw err;
  }
}
