import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from './eventLog.ts';
import { CONTROL_PROTOCOL_VERSION, CONTROL_TOKEN_FILE, PROTOCOL_HEADER, SESSION_HEADER } from './controlProtocol.ts';
import { startControlServer, type ControlServer } from './controlServer.ts';
import { closeProjectTaskStores, initProjectTaskStore } from './projectTasks.ts';
import { credentialHash } from './sessionCredentials.ts';

/**
 * The control API routes table in docs/contracts.md is the route contract:
 * every path the server matches is documented, and each documented method is
 * served while every other method on a documented path is not.
 */
const repoRoot = join(import.meta.dirname, '..');
const PARAM = '<>';
const METHODS = ['GET', 'POST'] as const;
/** Never documented: probed to prove the server does not serve them either. */
const OTHER_METHODS = ['PUT', 'PATCH', 'DELETE'] as const;

interface DocRoute { methods: string[]; paths: string[] }

/** Rows of the `### Routes` table: backticked methods and full `/v1/...` paths (query strings dropped). */
function documentedRoutes(markdown: string): DocRoute[] {
  const section = /^### Routes\n([\s\S]*?)(?=^#{2,3} )/m.exec(markdown)?.[1];
  if (!section) throw new Error('docs/contracts.md has no "### Routes" section');
  return section.split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const [methodCell, pathCell] = line.split('|').slice(1, 3);
      const ticks = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      return { methods: ticks(methodCell), paths: ticks(pathCell).map((path) => path.split('?')[0].replace(/<[^>]+>/g, PARAM)) };
    });
}

/** Expand a route regex body (`\/` unescaped, anchors removed) into concrete path patterns. */
function expandRoutePattern(pattern: string): string[] {
  let i = 0;
  const alternatives = (): string[] => {
    const out: string[] = [];
    for (;;) {
      out.push(...sequence());
      if (pattern[i] !== '|') return out;
      i += 1;
    }
  };
  const sequence = (): string[] => {
    let results = [''];
    while (i < pattern.length && pattern[i] !== ')' && pattern[i] !== '|') {
      let options: string[];
      if (pattern.startsWith('([^/]+)', i)) {
        options = [PARAM];
        i += '([^/]+)'.length;
      } else if (pattern[i] === '(') {
        i += pattern.startsWith('(?:', i) ? 3 : 1;
        options = alternatives();
        if (pattern[i] !== ')') throw new Error(`Unbalanced group in ${pattern}`);
        i += 1;
      } else {
        options = [pattern[i]];
        i += 1;
      }
      if (pattern[i] === '?') {
        options = [...options, ''];
        i += 1;
      }
      results = results.flatMap((prefix) => options.map((option) => prefix + option));
    }
    return results;
  };
  const expanded = alternatives();
  if (i !== pattern.length) throw new Error(`Unparsed route pattern: ${pattern}`);
  return expanded;
}

/** Every route path the server source matches: exact string literals and anchored regex literals. */
function sourceRoutes(source: string): string[] {
  const exact = [...source.matchAll(/'(\/v1\/[^']*)'/g)].map((match) => match[1]).filter((path) => !path.endsWith('/'));
  const patterns = [...source.matchAll(/\/\^(\\\/v1[^\n]*?)\$\//g)]
    .flatMap((match) => expandRoutePattern(match[1].replace(/\\\//g, '/')));
  return [...new Set([...exact, ...patterns])].sort();
}

function matches(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split('/');
  return a.length === b.length && a.every((segment, index) => segment === PARAM || segment === b[index]);
}

const docs = documentedRoutes(readFileSync(join(repoRoot, 'docs', 'contracts.md'), 'utf8'));
const documentedPaths = [...new Set(docs.flatMap((row) => row.paths))].sort();

describe('control API routes table (docs/contracts.md)', () => {
  it('parses route regexes into concrete paths', () => {
    expect(expandRoutePattern('/v1/tasks(?:/([^/]+)(/revisions)?)?')).toEqual(['/v1/tasks/<>/revisions', '/v1/tasks/<>', '/v1/tasks']);
    expect(expandRoutePattern('/v1/terminals/([^/]+)/(stream|lease)')).toEqual(['/v1/terminals/<>/stream', '/v1/terminals/<>/lease']);
  });

  it('documents every path lib/controlServer.ts routes, and nothing else', () => {
    const served = sourceRoutes(readFileSync(join(repoRoot, 'lib', 'controlServer.ts'), 'utf8'));
    expect(served.length).toBeGreaterThan(10);
    expect(documentedPaths).toEqual(served);
  });

  it('documents only GET and POST, with full paths', () => {
    for (const row of docs) {
      expect(row.methods.length).toBeGreaterThan(0);
      for (const method of row.methods) expect(METHODS).toContain(method);
      for (const path of row.paths) expect(path.startsWith('/v1/')).toBe(true);
    }
  });

  describe('against a running server', () => {
    let dir: string;
    let server: ControlServer;

    beforeEach(async () => {
      dir = createTempStateDir('orch-control-routes-');
      seedState(dir);
      // A running master session reads every route and gets past the session checks, so only routing decides.
      writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [
        { agent_id: 'master', provider: 'claude', role: 'master', capabilities: [], status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
      ] }));
      initEventsDb(dir);
      withEventDbTransaction(dir, (db) => {
        db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at, credential_hash)
          VALUES ('session-master', NULL, 'master', 'claude', 'running', '2026-01-01', '2026-01-01', ?)`).run(credentialHash('secret-master'));
      });
      initProjectTaskStore(dir);
      server = await startControlServer(dir, { pollMs: 20 });
    });

    afterEach(async () => {
      await server.close();
      closeProjectTaskStores();
      closeAllDatabases();
      cleanupTempStateDir(dir);
    });

    /** Whether the server routed the request (any answer but its own "No route for" 404). A stream that opens is routed. */
    function routed(method: string, path: string): Promise<boolean> {
      const headers = {
        authorization: `Bearer ${readFileSync(join(dir, CONTROL_TOKEN_FILE), 'utf8').trim()}`,
        [PROTOCOL_HEADER]: String(CONTROL_PROTOCOL_VERSION),
        [SESSION_HEADER]: 'secret-master',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      };
      return new Promise((resolve, reject) => {
        const req = request({ socketPath: server.endpoint.path, path, method, headers, agent: false }, (res) => {
          if (res.headers['content-type'] === 'application/x-ndjson') {
            req.destroy();
            resolve(true);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; error?: { message: string } };
            resolve(!(res.statusCode === 404 && body.error?.message.startsWith('No route for')));
          });
        });
        req.on('error', reject);
        req.end(method === 'POST' ? '{}' : undefined);
      });
    }

    it('serves exactly the documented methods on every documented path', async () => {
      for (const path of documentedPaths) {
        const concrete = path.replaceAll(PARAM, 'missing');
        for (const method of METHODS) {
          // A literal path can also match a parameterized one (`/v1/tasks/import` is `/v1/tasks/<ref>` to GET).
          const expected = docs.some((row) => row.methods.includes(method) && row.paths.some((pattern) => matches(pattern, concrete)));
          expect({ method, path, routed: await routed(method, concrete) }).toEqual({ method, path, routed: expected });
        }
        for (const method of OTHER_METHODS) {
          expect({ method, path, routed: await routed(method, concrete) }).toEqual({ method, path, routed: false });
        }
      }
    });
  });
});
