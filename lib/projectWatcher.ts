import { ControlClient, type CallOptions, type ControlClientOptions, type EventRow } from './controlClient.ts';
import type { ControlHealth } from './controlServer.ts';
import { CONTROL_PROTOCOL_VERSIONS, ControlError } from './controlProtocol.ts';
import { listProjects, type ProjectListEntry } from './projectList.ts';
import type { StatusView } from './statusView.ts';

// Part of the client entry (`orc-state/client`): Node built-ins only.

/**
 * - `connecting`: added with a running coordinator, before the first connect settles.
 * - `running`: the status and event stream are connected.
 * - `stopped`: no coordinator runs for the project (per the registry's liveness check).
 * - `unreachable`: a coordinator is registered as running but does not answer, or its stream was cut.
 * - `incompatible`: the coordinator speaks no control protocol version this client supports.
 */
export type ProjectConnectionState = 'connecting' | 'running' | 'stopped' | 'unreachable' | 'incompatible';

export interface ProjectWatchState {
  project: ProjectListEntry;
  connection: ProjectConnectionState;
  /** Why the project is `unreachable` or `incompatible` (null otherwise). */
  error: string | null;
  /** The latest `/v1/status` view; kept, possibly stale, while the project is not running. */
  status: StatusView | null;
  /** The highest event seq delivered; null until the first connect. */
  cursor: number | null;
}

export type ProjectWatchUpdate =
  | { type: 'added'; project_id: string; state: ProjectWatchState }
  | { type: 'removed'; project_id: string }
  | { type: 'connection'; project_id: string; connection: ProjectConnectionState; error: string | null }
  | { type: 'status'; project_id: string; status: StatusView }
  | { type: 'event'; project_id: string; row: EventRow }
  | { type: 'registry_error'; error: Error };

/** What the watcher needs from a project's client (`ControlClient` by default). */
export type ProjectWatchClient = Pick<ControlClient, 'health' | 'status' | 'subscribe'>;

/** Timer functions the watcher schedules with; tests may inject their own. */
export interface WatcherTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProjectWatcherOptions {
  /** The project registry; `listProjects()` by default. */
  listProjects?: () => ProjectListEntry[];
  /** One client per project; `new ControlClient(project.state_dir, clientOptions)` by default. */
  createClient?: (project: ProjectListEntry) => ProjectWatchClient;
  clientOptions?: ControlClientOptions;
  /** How often the registry is re-read for added/removed projects and coordinator liveness (default 2000 ms). */
  registryPollMs?: number;
  /** Events within this window share one status refresh (default 250 ms). */
  statusDebounceMs?: number;
  /** Reconnect backoff: doubles from `initialMs` (default 500) up to `maxMs` (default 30000). */
  backoff?: { initialMs?: number; maxMs?: number };
  /** `events` passed to `status()` (recent events in the view; default the route's 20). */
  statusEvents?: number;
  timers?: WatcherTimers;
}

interface Watched {
  state: ProjectWatchState;
  /** Null when `createClient` threw for the project: it stays `unreachable` with that error. */
  client: ProjectWatchClient | null;
  abort: AbortController;
  loop: Promise<void> | null;
  attempt: number;
  timer: unknown;
  wake: (() => void) | null;
  statusTimer: unknown;
  refreshing: Promise<void> | null;
  statusDirty: boolean;
}

const DEFAULT_TIMERS: WatcherTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIncompatible(error: unknown): boolean {
  return error instanceof ControlError && error.code === 'unsupported_protocol_version';
}

/** Whether the coordinator's `[min, max]` range overlaps this client's. */
function protocolOverlaps(health: Partial<ControlHealth>): [number, number] | null {
  const range = health.protocol_versions
    ?? (typeof health.protocol_version === 'number' ? [health.protocol_version, health.protocol_version] as const : null);
  if (!range) return null;
  const [min, max] = range;
  return max >= CONTROL_PROTOCOL_VERSIONS[0] && min <= CONTROL_PROTOCOL_VERSIONS[1] ? null : [min, max];
}

/**
 * Watches every registered project: one `ControlClient` per project, its
 * connection state, its latest status view and its new events. Reconnects
 * with bounded backoff after a coordinator restart, resuming the event
 * stream from the last delivered seq (no duplicates or gaps), and re-reads
 * the registry so projects registered or removed while it runs appear or
 * disappear. `stop()` closes every stream and timer.
 */
export class ProjectWatcher {
  private readonly list: () => ProjectListEntry[];
  private readonly createClient: (project: ProjectListEntry) => ProjectWatchClient;
  private readonly registryPollMs: number;
  private readonly statusDebounceMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly statusEvents: number | undefined;
  private readonly timers: WatcherTimers;
  private readonly watched = new Map<string, Watched>();
  private readonly listeners = new Set<(update: ProjectWatchUpdate) => void>();
  private running = false;
  private registryTimer: unknown = null;
  /** Message of the last registry error reported; cleared by a successful read. */
  private lastRegistryError: string | null = null;
  /** Removed projects whose loops are still ending; `stop()` waits for them. */
  private readonly retiring = new Set<Promise<void>>();

  constructor(options: ProjectWatcherOptions = {}) {
    this.list = options.listProjects ?? (() => listProjects());
    const clientOptions = options.clientOptions;
    this.createClient = options.createClient ?? ((project) => new ControlClient(project.state_dir, clientOptions));
    this.registryPollMs = options.registryPollMs ?? 2_000;
    this.statusDebounceMs = options.statusDebounceMs ?? 250;
    this.initialBackoffMs = options.backoff?.initialMs ?? 500;
    this.maxBackoffMs = Math.max(this.initialBackoffMs, options.backoff?.maxMs ?? 30_000);
    this.statusEvents = options.statusEvents;
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  /**
   * Receive every update; returns the unsubscribe function. A listener that
   * throws does not stop the watcher: its error is rethrown in a microtask.
   */
  onUpdate(listener: (update: ProjectWatchUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Every watched project's current state, in registry order of discovery. */
  projects(): ProjectWatchState[] {
    return [...this.watched.values()].map((w) => ({ ...w.state }));
  }

  /** Read the registry and connect to every project. Idempotent while running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollRegistry();
  }

  /** Close every stream and timer; resolves once every connection loop has ended. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.timers.clearTimeout(this.registryTimer);
    this.registryTimer = null;
    const ending = [...this.watched.values()].map((w) => this.retire(w));
    this.watched.clear();
    await Promise.all([...ending, ...this.retiring]);
  }

  private emit(update: ProjectWatchUpdate): void {
    for (const listener of [...this.listeners]) {
      try { listener(update); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  private pollRegistry(): void {
    if (!this.running) return;
    try {
      this.refreshRegistry();
    } finally {
      if (this.running) this.registryTimer = this.timers.setTimeout(() => this.pollRegistry(), this.registryPollMs);
    }
  }

  /** Re-read the registry: add, update and remove projects. A registry error keeps the current set. */
  private refreshRegistry(): void {
    if (!this.running) return;
    let entries: ProjectListEntry[];
    try {
      entries = this.list();
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      // A persistent error (e.g. RegistrySchemaError until orc-state is upgraded) is reported once.
      if (reported.message !== this.lastRegistryError) {
        this.lastRegistryError = reported.message;
        this.emit({ type: 'registry_error', error: reported });
      }
      return;
    }
    this.lastRegistryError = null;
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);
      const current = this.watched.get(entry.id);
      if (current && current.state.project.state_dir !== entry.state_dir) {
        this.remove(current);
      } else if (current) {
        const wasRunning = current.state.project.coordinator_running;
        current.state.project = entry;
        if (entry.coordinator_running !== wasRunning) current.wake?.();
        continue;
      }
      this.add(entry);
    }
    for (const w of [...this.watched.values()]) if (!seen.has(w.state.project.id)) this.remove(w);
  }

  private add(entry: ProjectListEntry): void {
    let client: ProjectWatchClient | null = null;
    let clientError: string | null = null;
    try { client = this.createClient(entry); } catch (error) { clientError = message(error); }
    const w: Watched = {
      state: {
        project: entry, connection: client ? (entry.coordinator_running ? 'connecting' : 'stopped') : 'unreachable',
        error: clientError, status: null, cursor: null,
      },
      client,
      abort: new AbortController(),
      loop: null, attempt: 0, timer: null, wake: null, statusTimer: null, refreshing: null, statusDirty: false,
    };
    this.watched.set(entry.id, w);
    this.emit({ type: 'added', project_id: entry.id, state: { ...w.state } });
    if (client) w.loop = this.run(w, client);
  }

  private remove(w: Watched): void {
    this.watched.delete(w.state.project.id);
    const ending = this.retire(w);
    this.retiring.add(ending);
    void ending.finally(() => this.retiring.delete(ending));
    this.emit({ type: 'removed', project_id: w.state.project.id });
  }

  /** Abort the project's calls, clear its timers and wait for its loop and status refresh to end. */
  private async retire(w: Watched): Promise<void> {
    w.abort.abort();
    this.timers.clearTimeout(w.statusTimer);
    w.statusTimer = null;
    w.wake?.();
    await Promise.all([w.loop, w.refreshing]);
  }

  private active(w: Watched): boolean {
    return this.running && !w.abort.signal.aborted;
  }

  private setConnection(w: Watched, connection: ProjectConnectionState, error: string | null): void {
    if (w.state.connection === connection && w.state.error === error) return;
    w.state.connection = connection;
    w.state.error = error;
    this.emit({ type: 'connection', project_id: w.state.project.id, connection, error });
  }

  /** Wait `ms` (forever when null) or until woken by a registry change or retirement. */
  private sleep(w: Watched, ms: number | null): Promise<void> {
    if (!this.active(w)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.timers.clearTimeout(w.timer);
        w.timer = null;
        w.wake = null;
        resolve();
      };
      w.wake = done;
      if (ms !== null) w.timer = this.timers.setTimeout(done, ms);
    });
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** Math.min(attempt, 30));
  }

  private async run(w: Watched, client: ProjectWatchClient): Promise<void> {
    while (this.active(w)) {
      if (!w.state.project.coordinator_running) {
        this.setConnection(w, 'stopped', null);
        w.attempt = 0;
        await this.sleep(w, null);
        continue;
      }
      let failure: string;
      try {
        await this.connect(w, client);
        failure = 'The coordinator closed the event stream';
      } catch (error) {
        if (!this.active(w)) break;
        if (isIncompatible(error)) {
          this.setConnection(w, 'incompatible', message(error));
          await this.sleep(w, this.maxBackoffMs);
          continue;
        }
        failure = message(error);
      }
      if (!this.active(w)) break;
      // A closed or cut stream: ask the registry whether the coordinator is gone or just not answering.
      this.refreshRegistry();
      if (!this.active(w)) break;
      if (!w.state.project.coordinator_running) continue;
      this.setConnection(w, 'unreachable', failure);
      await this.sleep(w, this.backoffMs(w.attempt++));
    }
  }

  /** Connect, then deliver events until the stream ends (resolves) or fails (throws). */
  private async connect(w: Watched, client: ProjectWatchClient): Promise<void> {
    const call: CallOptions = { signal: w.abort.signal };
    const health = await client.health(call);
    const theirs = protocolOverlaps(health);
    if (theirs) {
      throw new ControlError('unsupported_protocol_version',
        `The coordinator supports control protocol versions [${theirs.join(', ')}]; this client supports [${CONTROL_PROTOCOL_VERSIONS.join(', ')}]`, 400);
    }
    const status = await client.status(this.statusEvents === undefined ? {} : { events: this.statusEvents }, call);
    if (!this.active(w)) return;
    // First connect starts at the view's cursor; a reconnect resumes from the last delivered seq.
    w.state.cursor ??= status.cursor;
    w.attempt = 0;
    w.state.status = status;
    this.setConnection(w, 'running', null);
    this.emit({ type: 'status', project_id: w.state.project.id, status });
    for await (const row of client.subscribe(w.state.cursor, call)) {
      if (!this.active(w)) return;
      if (row.seq <= w.state.cursor) continue;
      w.state.cursor = row.seq;
      this.emit({ type: 'event', project_id: w.state.project.id, row });
      this.scheduleStatus(w);
    }
  }

  /** Coalesce the events of one `statusDebounceMs` window into one status refresh. */
  private scheduleStatus(w: Watched): void {
    if (w.statusTimer !== null) return;
    w.statusTimer = this.timers.setTimeout(() => {
      w.statusTimer = null;
      if (w.refreshing) { w.statusDirty = true; return; }
      w.refreshing = this.refreshStatus(w);
    }, this.statusDebounceMs);
  }

  private async refreshStatus(w: Watched): Promise<void> {
    const { client } = w;
    try {
      if (!client) return;
      do {
        w.statusDirty = false;
        try {
          const status = await client.status(this.statusEvents === undefined ? {} : { events: this.statusEvents }, { signal: w.abort.signal });
          if (!this.active(w) || w.state.connection !== 'running') return;
          w.state.status = status;
          this.emit({ type: 'status', project_id: w.state.project.id, status });
        } catch {
          // A failed refresh is not a connection change: the event stream reports that.
          return;
        }
      } while (w.statusDirty && this.active(w));
    } finally {
      w.refreshing = null;
    }
  }
}
