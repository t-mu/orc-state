import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import {
  ACTIVITY_NOTE_THROTTLE_MS, RUN_ACTIVITY_FILE, TOOL_IN_FLIGHT_MAX_MS, applyHookActivity, latestHookActivityTs,
  readRunActivity, shouldEmitActivityNote, toolInFlight, writeRunActivity,
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

  it('an empty todo label clears back to the last tool call, or to no label', () => {
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'activity', label: 'Write tests', source: 'todo', ts: at(0) },
      { type: 'tool', tool: 'Edit', brief: 'a.ts', ts: at(1000) },
      { type: 'activity', label: '', source: 'todo', ts: at(2000) },
    ], T0 + 5000);
    expect(snap).toMatchObject({ label: 'Edit: a.ts', source: 'tool', label_ts: at(1000) });
    const next = applyHookActivity(snap, 'run-1', 'w1', [{ type: 'tool', tool: 'Bash', brief: 'ls', ts: at(3000) }], T0 + 5000);
    expect(next).toMatchObject({ label: 'Bash: ls', source: 'tool' });

    const bare = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'activity', label: 'Plan', source: 'todo', ts: at(0) },
      { type: 'activity', label: '', source: 'todo', ts: at(1000) },
    ], T0 + 5000);
    expect(bare).toMatchObject({ label: null, source: null, label_ts: null });
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

  it('tracks a started tool call as in flight until its tool record closes it by id', () => {
    const started = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'tool_start', tool: 'Bash', id: 'a', ts: at(0) },
      { type: 'tool_start', tool: 'Agent', id: 'b', ts: at(1000) },
    ], T0 + 2000);
    expect(started.open_tools).toEqual({ a: at(0), b: at(1000) });
    expect(toolInFlight(started, T0 + 2000)).toBe(true);
    expect(latestHookActivityTs(started)).toBe(at(1000));

    const oneDone = applyHookActivity(started, 'run-1', 'w1', [{ type: 'tool', tool: 'Agent', brief: '', id: 'b', ts: at(3000) }], T0 + 4000);
    expect(oneDone.open_tools).toEqual({ a: at(0) });
    expect(toolInFlight(oneDone, T0 + 4000)).toBe(true);

    const allDone = applyHookActivity(oneDone, 'run-1', 'w1', [{ type: 'tool', tool: 'Bash', brief: 'npm test', id: 'a', ts: at(5000) }], T0 + 6000);
    expect(allDone.open_tools).toBeUndefined();
    expect(toolInFlight(allDone, T0 + 6000)).toBe(false);
    expect(started.open_tools).toEqual({ a: at(0), b: at(1000) }); // pure
  });

  it('a failed call (PostToolUseFailure writes the same tool record) closes its start', () => {
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'tool_start', tool: 'Bash', id: 'a', ts: at(0) },
      { type: 'tool', tool: 'Bash', brief: 'grep -q missing x', id: 'a', ts: at(1000) },
    ], T0 + 2000);
    expect(toolInFlight(snap, T0 + 2000)).toBe(false);
  });

  it('a new tool_start closes an anonymous start older than the newest finished call (no record can name it)', () => {
    const lost = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'tool_start', tool: 'Bash', ts: at(0) },
      { type: 'tool_start', tool: 'Read', id: 'b', ts: at(100) },
      { type: 'tool', tool: 'Read', brief: 'a.ts', id: 'b', ts: at(1000) },
    ], T0 + 2000);
    expect(lost.open_tools).toEqual({ _: at(0) });
    const next = applyHookActivity(lost, 'run-1', 'w1', [{ type: 'tool_start', tool: 'Edit', id: 'c', ts: at(3000) }], T0 + 4000);
    expect(next.open_tools).toEqual({ c: at(3000) });
  });

  it('keeps an id-keyed call open while parallel sub-agents finish and start other calls', () => {
    // Reviewer 1 runs npm test; reviewer 2 reads, finishes, and starts another call meanwhile.
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'tool_start', tool: 'Bash', id: 'r1-test', ts: at(0) },
      { type: 'tool_start', tool: 'Read', id: 'r2-read', ts: at(100) },
      { type: 'tool', tool: 'Read', brief: 'a.ts', id: 'r2-read', ts: at(1000) },
      { type: 'tool_start', tool: 'Grep', id: 'r2-grep', ts: at(2000) },
      { type: 'tool', tool: 'Grep', brief: 'x', id: 'r2-grep', ts: at(3000) },
    ], T0 + 4000);
    expect(snap.open_tools).toEqual({ 'r1-test': at(0) });
    expect(toolInFlight(snap, T0 + 10 * 60_000)).toBe(true);
  });

  it('pairs tool calls without a tool_use_id one at a time', () => {
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [
      { type: 'tool_start', tool: 'Bash', ts: at(0) },
      { type: 'tool', tool: 'Bash', brief: '', ts: at(1000) },
    ], T0 + 2000);
    expect(toolInFlight(snap, T0 + 2000)).toBe(false);
  });

  it('stops counting a tool call that never finished after TOOL_IN_FLIGHT_MAX_MS and prunes it', () => {
    const snap = applyHookActivity(undefined, 'run-1', 'w1', [{ type: 'tool_start', tool: 'Bash', id: 'a', ts: at(0) }], T0 + 1000);
    expect(toolInFlight(snap, T0 + TOOL_IN_FLIGHT_MAX_MS - 1)).toBe(true);
    expect(toolInFlight(snap, T0 + TOOL_IN_FLIGHT_MAX_MS)).toBe(false);
    const later = applyHookActivity(snap, 'run-1', 'w1', [], T0 + TOOL_IN_FLIGHT_MAX_MS);
    expect(later.open_tools).toBeUndefined();
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
