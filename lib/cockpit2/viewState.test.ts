import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_STATE, createViewStateStore, parseViewState, serializeViewState, type ViewState } from './viewState.ts';

const STATE: ViewState = {
  tabs: { activeProject: 'p2', projects: [{ projectId: 'p1', tabs: ['w1'], active: 'w1' }, { projectId: 'p2', tabs: [], active: null }] },
  masterTargets: { p1: { socket: 'orc-aaa', session: 'orc-master-1' } },
};

describe('parseViewState', () => {
  it('reads back what serializeViewState wrote', () => {
    expect(parseViewState(serializeViewState(STATE))).toEqual(STATE);
  });

  it('loads a missing, corrupt or foreign file as the defaults', () => {
    for (const raw of [null, '', '{', '[]', '{"v":2,"activeProject":null,"projects":[]}', '{"v":1,"activeProject":null,"projects":[{"projectId":""}]}']) {
      expect(parseViewState(raw)).toEqual(DEFAULT_VIEW_STATE);
    }
  });

  it('keeps the tabs and drops invalid master targets', () => {
    const raw = JSON.stringify({ v: 1, ...STATE.tabs, masterTargets: { p1: { socket: 'orc-a', session: 's' }, p2: { socket: '' }, p3: 'x' } });
    expect(parseViewState(raw)).toEqual({ tabs: STATE.tabs, masterTargets: { p1: { socket: 'orc-a', session: 's' } } });
    expect(parseViewState(JSON.stringify({ v: 1, ...STATE.tabs, masterTargets: [] })).masterTargets).toEqual({});
  });
});

describe('createViewStateStore', () => {
  let dir: string;
  let path: string;
  let lockPath: string;
  const put = (state: ViewState) => () => state;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orc-view-state-'));
    path = join(dir, 'cockpit', 'view-state.json');
    lockPath = join(dir, 'cockpit', 'view-state.lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads the defaults before the first save', () => {
    expect(createViewStateStore({ path, lockPath }).load()).toEqual(DEFAULT_VIEW_STATE);
  });

  it('saves atomically with mode 0600 and loads it back, leaving no temp or lock file', async () => {
    const store = createViewStateStore({ path, lockPath });
    await store.update(put(STATE));
    expect(store.load()).toEqual(STATE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'cockpit')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, 'cockpit'))).toEqual(['view-state.json']);
  });

  it('loads a corrupt file as the defaults, and a save replaces it', async () => {
    const store = createViewStateStore({ path, lockPath });
    await store.update(put(STATE));
    writeFileSync(path, '{"v":1,"activeProject":');
    expect(store.load()).toEqual(DEFAULT_VIEW_STATE);
    await store.update(put(STATE));
    expect(store.load()).toEqual(STATE);
  });

  it('serializes concurrent updates: none is lost and the file is always one complete state', async () => {
    const stores = [createViewStateStore({ path, lockPath }), createViewStateStore({ path, lockPath })];
    await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 2].update((stored) => ({
      ...stored, masterTargets: { ...stored.masterTargets, [`p${i}`]: { socket: `orc-${i}`, session: `orc-master-${i}` } },
    }))));
    expect(Object.keys(stores[0].load().masterTargets)).toHaveLength(30);
    expect(readdirSync(join(dir, 'cockpit'))).toEqual(['view-state.json']);
  });

  it('serializes concurrent replacing saves: the file is always one complete state', async () => {
    const stores = [createViewStateStore({ path, lockPath }), createViewStateStore({ path, lockPath })];
    const states = Array.from({ length: 30 }, (_, i): ViewState => ({
      tabs: { activeProject: `p${i}`, projects: [{ projectId: `p${i}`, tabs: Array.from({ length: i }, (_, t) => `w${t}`), active: null }] },
      masterTargets: { [`p${i}`]: { socket: `orc-${i}`, session: `orc-master-${i}` } },
    }));
    const reads: ViewState[] = [];
    await Promise.all(states.map(async (state, i) => {
      await stores[i % 2].update(put(state));
      reads.push(stores[0].load());
    }));
    for (const read of [...reads, stores[1].load()]) expect(states).toContainEqual(read);
    expect(readdirSync(join(dir, 'cockpit'))).toEqual(['view-state.json']);
  });

  it('waits for a held lock, takes over a stale one, and gives up on a live one after the timeout', async () => {
    const store = createViewStateStore({ path, lockPath, lockTimeoutMs: 100, staleLockMs: 60_000 });
    await store.update(put(DEFAULT_VIEW_STATE));
    const lock = lockPath;
    writeFileSync(lock, '1\n');
    await expect(store.update(put(STATE))).rejects.toThrow('locked');
    expect(store.load()).toEqual(DEFAULT_VIEW_STATE);
    expect(readdirSync(join(dir, 'cockpit')).sort()).toEqual(['view-state.json', 'view-state.lock']);

    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await store.update(put(STATE));
    expect(store.load()).toEqual(STATE);
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(serializeViewState(STATE));
  });

  it('leaves a lock another writer took over in place when releasing its own', async () => {
    const store = createViewStateStore({ path, lockPath });
    await store.update((stored) => {
      writeFileSync(lockPath, 'another writer\n'); // taken over as stale while this update ran
      return stored;
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('another writer\n');
  });
});
