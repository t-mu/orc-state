import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_ENDPOINT_FILE, CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE } from './controlProtocol.ts';
import type { ProjectListEntry } from './projectList.ts';
import { ProjectWatcher, type ProjectWatchUpdate } from './projectWatcher.ts';

/** A fake coordinator: health, status (with an agent's `attention`) and an event stream over an in-memory log. */
class FakeCoordinator {
  readonly dir: string;
  readonly socket: string;
  events: Array<{ seq: number; event: { event: string } }> = [];
  protocolVersions: [number, number] = [1, CONTROL_PROTOCOL_VERSION];
  streamOpens: number[] = [];
  private server: Server | null = null;
  private streams = new Set<{ res: ServerResponse; after: number }>();

  constructor(dir: string) {
    this.dir = dir;
    this.socket = join(dir, 'c.sock');
    writeFileSync(join(dir, CONTROL_TOKEN_FILE), 'token');
  }

  get running(): boolean { return this.server !== null; }

  append(count = 1): void {
    for (let i = 0; i < count; i++) {
      const row = { seq: (this.events.at(-1)?.seq ?? 0) + 1, event: { event: `e${this.events.length + 1}` } };
      this.events.push(row);
      for (const s of this.streams) s.res.write(`${JSON.stringify({ type: 'event', ...row })}\n`);
    }
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ protocol_version: CONTROL_PROTOCOL_VERSION, ok: true, result }));
      };
      if (url.pathname === '/v1/health') {
        reply({ version: 't', protocol_version: this.protocolVersions[1], protocol_versions: this.protocolVersions });
      } else if (url.pathname === '/v1/status') {
        reply({ cursor: this.events.at(-1)?.seq ?? 0, agents: [{ agent_id: 'w1', attention: { reason: 'no_progress' } }] });
      } else if (url.pathname === '/v1/events/stream') {
        const after = Number(url.searchParams.get('after'));
        this.streamOpens.push(after);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const row of this.events) if (row.seq > after) res.write(`${JSON.stringify({ type: 'event', ...row })}\n`);
        const entry = { res, after };
        this.streams.add(entry);
        res.on('close', () => this.streams.delete(entry));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(this.socket, resolve));
    writeFileSync(join(this.dir, CONTROL_ENDPOINT_FILE), JSON.stringify({
      protocol_version: CONTROL_PROTOCOL_VERSION, transport: 'unix', path: this.socket, pid: process.pid, started_at: new Date().toISOString(),
    }));
    this.server = server;
  }

  /** Shut down as the daemon does: a `closed` frame on every stream, then close (the stale control.json stays). */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const s of this.streams) s.res.end(`${JSON.stringify({ type: 'closed', reason: 'shutdown' })}\n`);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let root: string;
const coordinators: FakeCoordinator[] = [];
let watcher: ProjectWatcher | null = null;

function project(id: string, coordinator: FakeCoordinator | null): () => ProjectListEntry {
  const stateDir = coordinator?.dir ?? mkdtempSync(join(root, `${id}-`));
  return () => ({
    id, name: id, target_repo_root: '/repo', state_dir: stateDir, repo_present: true,
    control_socket: coordinator?.running ? coordinator.socket : null, coordinator_running: coordinator?.running ?? false,
  });
}

async function coordinator(): Promise<FakeCoordinator> {
  const c = new FakeCoordinator(mkdtempSync(join(root, 'p-')));
  coordinators.push(c);
  await c.start();
  return c;
}

function watch(registry: Array<() => ProjectListEntry>): { watcher: ProjectWatcher; updates: ProjectWatchUpdate[] } {
  const w = new ProjectWatcher({
    listProjects: () => registry.map((entry) => entry()),
    registryPollMs: 20, statusDebounceMs: 10, backoff: { initialMs: 10, maxMs: 50 },
  });
  const updates: ProjectWatchUpdate[] = [];
  w.onUpdate((u) => updates.push(u));
  watcher = w;
  w.start();
  return { watcher: w, updates };
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const connection = (w: ProjectWatcher, id: string): string | undefined => w.projects().find((p) => p.project.id === id)?.connection;
const seqs = (updates: ProjectWatchUpdate[], id: string): number[] =>
  updates.flatMap((u) => (u.type === 'event' && u.project_id === id ? [u.row.seq] : []));

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'orc-watch-')); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

afterEach(async () => {
  await watcher?.stop();
  watcher = null;
  for (const c of coordinators.splice(0)) await c.stop();
});

describe('ProjectWatcher', () => {
  it('reports every project with status and events; one without a coordinator is stopped', async () => {
    const a = await coordinator();
    const b = await coordinator();
    a.append(2);
    const { watcher: w, updates } = watch([project('a', a), project('b', b), project('c', null)]);
    await until(() => connection(w, 'a') === 'running' && connection(w, 'b') === 'running');
    expect(connection(w, 'c')).toBe('stopped');
    const status = w.projects().find((p) => p.project.id === 'a')?.status as unknown as { agents: Array<{ attention: unknown }> };
    expect(status.agents[0].attention).toEqual({ reason: 'no_progress' });
    // Events before the first connect are in the status view; the stream delivers only new ones.
    a.append(1);
    b.append(1);
    await until(() => seqs(updates, 'a').length === 1 && seqs(updates, 'b').length === 1);
    expect(seqs(updates, 'a')).toEqual([3]);
    expect(seqs(updates, 'b')).toEqual([1]);
    // An event triggers a (coalesced) status refresh.
    await until(() => updates.filter((u) => u.type === 'status' && u.project_id === 'a').length >= 2);
  });

  it('follows a coordinator restart and resumes from the last cursor without duplicates or gaps', async () => {
    const a = await coordinator();
    const { watcher: w, updates } = watch([project('a', a)]);
    await until(() => connection(w, 'a') === 'running');
    a.append(3);
    await until(() => seqs(updates, 'a').length === 3);
    await a.stop();
    await until(() => connection(w, 'a') !== 'running');
    // Events written while the watcher is disconnected (e.g. by the coordinator's shutdown).
    a.append(2);
    await a.start();
    await until(() => connection(w, 'a') === 'running');
    a.append(1);
    await until(() => seqs(updates, 'a').length === 6);
    expect(seqs(updates, 'a')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.streamOpens.at(-1)).toBe(3);
    const states = updates.flatMap((u) => (u.type === 'connection' ? [u.connection] : []));
    expect(states[0]).toBe('running');
    expect(states.slice(1, -1).every((s) => s === 'stopped' || s === 'unreachable')).toBe(true);
    expect(states.at(-1)).toBe('running');
  });

  it('reports unreachable while a running coordinator does not answer, then reconnects', async () => {
    const a = await coordinator();
    await a.stop();
    // The registry still says it runs (pid alive) but the socket refuses.
    const entry = (): ProjectListEntry => ({ ...project('a', a)(), coordinator_running: true });
    const { watcher: w, updates } = watch([entry]);
    await until(() => connection(w, 'a') === 'unreachable');
    expect(w.projects()[0].error).toMatch(/not running/);
    await a.start();
    await until(() => connection(w, 'a') === 'running');
    expect(updates.some((u) => u.type === 'connection' && u.connection === 'unreachable')).toBe(true);
  });

  it('picks up projects registered and removed while it runs', async () => {
    const a = await coordinator();
    const registry = [project('a', a)];
    const { watcher: w, updates } = watch(registry);
    await until(() => connection(w, 'a') === 'running');
    const b = await coordinator();
    registry.push(project('b', b));
    await until(() => connection(w, 'b') === 'running');
    registry.shift();
    await until(() => w.projects().length === 1);
    expect(w.projects()[0].project.id).toBe('b');
    expect(updates).toContainEqual({ type: 'removed', project_id: 'a' });
  });

  it('a coordinator that starts later moves the project from stopped to running', async () => {
    const a = new FakeCoordinator(mkdtempSync(join(root, 'late-')));
    coordinators.push(a);
    const { watcher: w } = watch([project('a', a)]);
    await until(() => connection(w, 'a') === 'stopped');
    await a.start();
    await until(() => connection(w, 'a') === 'running');
  });

  it('reports a coordinator outside the protocol range as incompatible instead of throwing', async () => {
    const a = await coordinator();
    a.protocolVersions = [CONTROL_PROTOCOL_VERSION + 1, CONTROL_PROTOCOL_VERSION + 2];
    const { watcher: w } = watch([project('a', a)]);
    await until(() => connection(w, 'a') === 'incompatible');
    expect(w.projects()[0].error).toMatch(/protocol versions \[2, 3\]/);
    expect(a.streamOpens).toEqual([]);
  });

  it('reports a registry error without dropping the projects it watches', async () => {
    const a = await coordinator();
    let broken = false;
    const w = new ProjectWatcher({
      listProjects: () => { if (broken) throw new Error('newer schema'); return [project('a', a)()]; },
      registryPollMs: 10, backoff: { initialMs: 10, maxMs: 50 },
    });
    watcher = w;
    const errors: string[] = [];
    w.onUpdate((u) => { if (u.type === 'registry_error') errors.push(u.error.message); });
    w.start();
    await until(() => connection(w, 'a') === 'running');
    broken = true;
    await until(() => errors.length > 0);
    expect(errors[0]).toBe('newer schema');
    expect(connection(w, 'a')).toBe('running');
  });

  it('stop closes every stream and timer', async () => {
    const a = await coordinator();
    const timers = new Set<unknown>();
    const w = new ProjectWatcher({
      listProjects: () => [project('a', a)()],
      registryPollMs: 10, statusDebounceMs: 10,
      timers: {
        setTimeout: (callback, ms) => { const h = setTimeout(() => { timers.delete(h); callback(); }, ms); timers.add(h); return h; },
        clearTimeout: (h) => { clearTimeout(h as NodeJS.Timeout); timers.delete(h); },
      },
    });
    w.start();
    await until(() => connection(w, 'a') === 'running');
    a.append(1);
    await w.stop();
    expect(timers.size).toBe(0);
    expect(w.projects()).toEqual([]);
    // The server sees no open stream once the watcher stopped.
    await until(() => (a as unknown as { streams: Set<unknown> }).streams.size === 0);
  });
});
