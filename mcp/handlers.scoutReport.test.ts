import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tail = vi.fn<() => string | null>();
const alive = vi.fn<() => Promise<boolean>>();
const stop = vi.fn<() => Promise<void>>();

vi.mock('../adapters/index.ts', () => ({
  createAdapter: vi.fn(() => ({ start: vi.fn(), send: vi.fn(), attach: vi.fn(), heartbeatProbe: alive, stop, getOutputTail: tail })),
}));

const { extractScoutReport, handleGetScoutReport, handleRemoveScout } = await import('./handlers.ts');

const template = readFileSync(resolve(import.meta.dirname, '../templates/scout-brief-v1.txt'), 'utf8');
const report = 'SCOUT_REPORT\nfindings:\nthe lease expired\n\nlikely_cause:\nclock skew\n\nrecommended_action:\nreset the task\nSCOUT_REPORT_END';
let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = createTempStateDir('orc-scout-report-test-');
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [
    { agent_id: 'scout-1', provider: 'claude', role: 'scout', status: 'running', session_handle: 'pty:scout-1', capabilities: [], registered_at: '2026-01-01T00:00:00.000Z' },
    { agent_id: 'worker-a', provider: 'claude', role: 'worker', status: 'running', session_handle: 'pty:worker-a', capabilities: [], registered_at: '2026-01-01T00:00:00.000Z' },
  ] }));
});

afterEach(() => cleanupTempStateDir(dir));

describe('extractScoutReport', () => {
  const body = 'findings:\nthe lease expired\n\nlikely_cause:\nclock skew\n\nrecommended_action:\nreset the task';

  it('ignores the echoed template and returns the last real report, even behind prompt glyphs', () => {
    expect(extractScoutReport(template)).toEqual({ report: null, truncated: false });
    expect(extractScoutReport(`${template}\nworking...\n⏺ ${report}\n> `)).toEqual({ report: body, truncated: false });
    expect(extractScoutReport('I will emit a SCOUT_REPORT soon')).toEqual({ report: null, truncated: false });
  });

  it('ignores a report quoted inside other output, and one missing its headers', () => {
    // A scout reading this repository's tests sees the literal on one line, not a block.
    expect(extractScoutReport(`const report = 'SCOUT_REPORT\\nfindings:...SCOUT_REPORT_END';`).report).toBeNull();
    expect(extractScoutReport('SCOUT_REPORT\nnot a report\nSCOUT_REPORT_END').report).toBeNull();
  });

  it('keeps a scout running when its tail begins inside the echoed template', () => {
    const cut = template.slice(template.indexOf('likely_cause:'));
    expect(extractScoutReport(`${cut}\nstill investigating...`)).toEqual({ report: null, truncated: false });
    // A later, complete report still wins.
    expect(extractScoutReport(`${cut}\n${report}`).report).toContain('clock skew');
  });

  it('reports truncation when the end marker survives but the start fell outside the output read', () => {
    expect(extractScoutReport(`likely_cause:\nclock skew\nSCOUT_REPORT_END`)).toEqual({ report: null, truncated: true });
  });
});

describe('scout report tools', () => {
  it('reports running, reported and ended states from the session output', async () => {
    tail.mockReturnValue(template);
    alive.mockResolvedValue(true);
    expect(await handleGetScoutReport(dir, { agent_id: 'scout-1' })).toMatchObject({ status: 'running', report: null, launched_at: '2026-01-01T00:00:00.000Z' });
    tail.mockReturnValue(`${template}\n${report}`);
    expect(await handleGetScoutReport(dir, { agent_id: 'scout-1' })).toMatchObject({ status: 'reported', report: expect.stringContaining('clock skew') });
    expect(tail).toHaveBeenLastCalledWith('pty:scout-1', 64 * 1024);
    tail.mockReturnValue('recommended_action:\nreset\nSCOUT_REPORT_END');
    expect(await handleGetScoutReport(dir, { agent_id: 'scout-1' })).toMatchObject({ status: 'truncated', report: null });
    tail.mockReturnValue(template);
    alive.mockResolvedValue(false);
    expect(await handleGetScoutReport(dir, { agent_id: 'scout-1' })).toMatchObject({ status: 'ended', report: null });
  });

  it('removes only scouts, stopping the session first', async () => {
    stop.mockResolvedValue();
    await expect(handleRemoveScout(dir, { agent_id: 'worker-a' })).rejects.toThrow('not a scout');
    await expect(handleGetScoutReport(dir, { agent_id: 'missing' })).rejects.toThrow('Scout not found');
    expect(await handleRemoveScout(dir, { agent_id: 'scout-1' })).toEqual({ agent_id: 'scout-1', removed: true });
    expect(stop).toHaveBeenCalledWith('pty:scout-1');
    expect(await handleRemoveScout(dir, { agent_id: 'scout-1' })).toEqual({ agent_id: 'scout-1', removed: false, reason: 'not_found' });
    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as { agents: Array<{ agent_id: string }> };
    expect(agents.agents.map((agent) => agent.agent_id)).toEqual(['worker-a']);
  });
});

describe('task authoring in a project without its task store', () => {
  it('refuses instead of writing legacy backlog.json', async () => {
    const { handleCreateTask, handleUpdateTask } = await import('./handlers.ts');
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'p1', name: 'p', target_repo_root: dir }));
    expect(() => handleCreateTask(dir, { feature: 'app', title: 'Lost' })).toThrow('Project task store is missing');
    expect(() => handleUpdateTask(dir, { task_ref: 'app/lost', priority: 'high' })).toThrow('Project task store is missing');
  });
});
