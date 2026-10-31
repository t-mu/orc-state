import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import {
  ACTIVITY_NOTE_THROTTLE_MS, RUN_ACTIVITY_FILE, applyHookActivity, latestHookActivityTs,
  readRunActivity, shouldEmitActivityNote, writeRunActivity,
} from './runActivityStore.ts';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe('applyHookActivity', () => {
  it('labels a run from tool calls while it has no todo/note label', () => {
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'tool', tool: 'Bash', brief: 'npm test', ts: at(0) },
      { type: 'tool', tool: 'Read', brief: '', ts: at(1000) },
    ], T0 + 5000);
    expect(snap).toEqual({
      run_id: 'run-1', agent_id: 'w1', label: 'Read', source: 'tool', label_ts: at(1000),
      last_tool: 'Read', last_tool_brief: '', last_tool_ts: at(1000),
    });
  });

  it('keeps a todo/note label over later tool calls, which still update last_tool', () => {
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'activity', label: 'Write tests', source: 'todo', ts: at(0) },
      { type: 'tool', tool: 'Edit', brief: 'a.ts', ts: at(1000) },
    ], T0 + 5000);
    expect(snap).toMatchObject({ label: 'Write tests', source: 'todo', label_ts: at(0), last_tool: 'Edit', last_tool_ts: at(1000) });
    expect(latestHookActivityTs(snap)).toBe(at(1000));
  });

  it('ignores out-of-order older events and clamps future timestamps to now', () => {
    const first = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'activity', label: 'Newer', source: 'note', ts: at(2000) },
    ], T0 + 5000);
    const second = applyHookActivity(first, 'run-1', 'w1', [
      { type: 'activity', label: 'Older', source: 'note', ts: at(1000) },
      { type: 'tool', tool: 'Bash', brief: '', ts: at(60_000) },
    ], T0 + 5000);
    expect(second.label).toBe('Newer');
    expect(second.last_tool_ts).toBe(at(5000));
    expect(first.label).toBe('Newer'); // pure: previous snapshot untouched
  });

  it('latestHookActivityTs is null without a snapshot or timestamps', () => {
    expect(latestHookActivityTs(undefined)).toBeNull();
    expect(latestHookActivityTs(applyHookActivity(undefined, 'r', 'w', []))).toBeNull();
  });
});

describe('shouldEmitActivityNote', () => {
  it('emits the first label, not the same label again, and throttles changes', () => {
    expect(shouldEmitActivityNote(undefined, null, T0)).toBe(false);
    expect(shouldEmitActivityNote(undefined, 'A', T0)).toBe(true);
    const last = { label: 'A', emitted_at_ms: T0 };
    expect(shouldEmitActivityNote(last, 'A', T0 + ACTIVITY_NOTE_THROTTLE_MS * 10)).toBe(false);
    expect(shouldEmitActivityNote(last, 'B', T0 + ACTIVITY_NOTE_THROTTLE_MS - 1)).toBe(false);
    expect(shouldEmitActivityNote(last, 'B', T0 + ACTIVITY_NOTE_THROTTLE_MS)).toBe(true);
  });
});

describe('run activity projection', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = createTempStateDir('run-activity-test-'); });
  afterEach(() => { cleanupTempStateDir(stateDir); });

  it('returns {} when the file is missing or unreadable', () => {
    expect(readRunActivity(stateDir)).toEqual({});
    writeFileSync(join(stateDir, RUN_ACTIVITY_FILE), '{not json');
    expect(readRunActivity(stateDir)).toEqual({});
  });

  it('is readable from another process via readRunActivity', () => {
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [{ type: 'tool', tool: 'Bash', brief: 'ls', ts: at(0) }], T0);
    writeRunActivity(stateDir, { 'run-1': snap });

    const moduleUrl = new URL('./runActivityStore.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `const { readRunActivity } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(readRunActivity(process.argv[1])));`,
      stateDir,
    ], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ 'run-1': snap });
  });
});
