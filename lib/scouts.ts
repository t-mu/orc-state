import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAdapter } from '../adapters/index.ts';
import { getAgent, nextAvailableScoutId, registerAgent, removeAgent } from './agentRegistry.ts';
import { DEFAULT_SCOUT_READY_TIMEOUT_MS } from './constants.ts';
import { InputError, NotFoundError } from './domainErrors.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { TARGET_REPO_ROOT } from './paths.ts';
import { hasSessionStartHook, isSupportedProvider, loadWorkerPoolConfig } from './providers.ts';
import { renderTemplate } from './templateRender.ts';
import { launchWorkerSession } from './workerRuntime.ts';
import type { Agent } from '../types/agents.ts';
import type { OrcEventInput } from '../types/events.ts';
import type { RunWorktreesState } from '../types/run-worktrees.ts';

/** What a caller asks a scout to investigate (the `request_scout` arguments). */
export interface ScoutRequest {
  objective?: unknown;
  provider?: unknown;
  run_id?: unknown;
  task_ref?: unknown;
  scope_paths?: unknown;
  use_web?: unknown;
}

/** A validated, registered scout whose session has not been launched yet. */
export interface PreparedScout {
  scout: Agent;
  objective: string;
  run_id: string | null;
  task_ref: string | null;
  use_web: boolean;
  scope_paths: string[];
  working_directory: string;
  repo_root: string;
  sandbox_network: ReturnType<typeof loadWorkerPoolConfig>['sandbox_network'];
}

/** A launch that failed after the scout was registered; the scout is already removed. `hint` says how to fix it. */
export class ScoutLaunchError extends Error {
  override name = 'ScoutLaunchError';
  readonly reason: string;
  readonly hint: string | null;
  constructor(reason: string, hint: string | null = null) {
    super(hint ? `${reason}; ${hint}` : reason);
    this.reason = reason;
    this.hint = hint;
  }
}

function readRunWorktreesState(stateDir: string): RunWorktreesState {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'run-worktrees.json'), 'utf8')) as RunWorktreesState;
  } catch {
    return { version: '1', runs: [] };
  }
}

export function scopeLines(scopePaths: string[] | undefined) {
  if (!scopePaths || scopePaths.length === 0) {
    return '- (none specified — search broadly from working_directory)';
  }
  return scopePaths.map((path) => `- ${path}`).join('\n')
    + '\n\nDo not expand beyond scope_paths unless all listed paths are exhausted with no findings.';
}

function assertStringArray(value: unknown, field: string) {
  if (value == null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new InputError(`${field} must be an array of strings`);
  }
}

async function waitForScoutReady(
  stateDir: string,
  agentId: string,
  sessionToken: string,
  initialAgent: Agent | null,
  timeoutMs = Number(process.env.ORC_SCOUT_READY_TIMEOUT_MS ?? DEFAULT_SCOUT_READY_TIMEOUT_MS),
) {
  const isReady = (agent: Agent | null | undefined) => Boolean(agent?.session_handle
    && agent.session_token === sessionToken
    && agent.session_ready_at
    && agent.session_started_at
    && new Date(agent.session_ready_at).getTime() >= new Date(agent.session_started_at).getTime());
  if (isReady(initialAgent)) return true;
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (isReady(getAgent(stateDir, agentId))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Validate a scout request and register the scout; no session exists yet.
 * `actorProvider` is the requesting master's provider, the default for a request without one.
 */
export function prepareScout(stateDir: string, request: ScoutRequest, actorProvider: string | null): PreparedScout {
  const { objective, provider, run_id = null, task_ref = null, scope_paths = [], use_web = false } = request;
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new InputError('objective is required');
  }
  if (provider != null && !isSupportedProvider(provider)) {
    throw new InputError(`Invalid provider: ${typeof provider === 'string' ? provider : '(unknown)'}`);
  }
  if (run_id != null && typeof run_id !== 'string') throw new InputError('run_id must be a string');
  if (task_ref != null && typeof task_ref !== 'string') throw new InputError('task_ref must be a string');
  assertStringArray(scope_paths, 'scope_paths');
  if (typeof use_web !== 'boolean') throw new InputError('use_web must be a boolean');

  const resolvedProvider = typeof provider === 'string' ? provider : actorProvider ?? 'codex';
  // Scouts start in the target repository.
  const repoRoot = TARGET_REPO_ROOT;
  const recordedWorktree = typeof run_id === 'string'
    ? (readRunWorktreesState(stateDir).runs.find((entry) => entry.run_id === run_id)?.worktree_path ?? null)
    : null;
  // A stalled run's worktree may be gone, which is exactly when a scout is wanted — investigate from the root.
  const linkedWorktree = recordedWorktree != null && existsSync(recordedWorktree) ? recordedWorktree : null;

  // A scout gets the control socket under the same opt-in as workers; a Codex or Gemini
  // scout reports for duty through it (a Claude scout is made ready by its session-start hook).
  // Resolved before registering, so an invalid setting leaves no scout behind.
  const sandboxNetwork = loadWorkerPoolConfig().sandbox_network;

  const scout = registerAgent(stateDir, {
    agent_id: nextAvailableScoutId(stateDir),
    provider: resolvedProvider,
    role: 'scout',
  });
  return {
    scout, objective: objective.trim(), run_id: run_id as string | null, task_ref: task_ref as string | null,
    use_web, scope_paths: (scope_paths ?? []) as string[], working_directory: linkedWorktree ?? repoRoot,
    repo_root: repoRoot, sandbox_network: sandboxNetwork,
  };
}

/**
 * Launch a prepared scout's session, wait until it is ready and send its brief.
 * On any failure the session is stopped and the scout removed, and a
 * `ScoutLaunchError` says why.
 */
export async function launchScout(stateDir: string, prepared: PreparedScout) {
  const { scout, working_directory: workingDirectory } = prepared;
  const adapter = createAdapter(scout.provider);
  const launchResult = await launchWorkerSession(stateDir, scout, {
    adapter,
    workingDirectory,
    repoRoot: prepared.repo_root,
    ...(prepared.sandbox_network ? { sandboxNetwork: prepared.sandbox_network } : {}),
    emit: (event) => appendSequencedEvent(stateDir, event),
  });
  if (!launchResult.ok || !launchResult.session_handle) {
    removeAgent(stateDir, scout.agent_id);
    throw new ScoutLaunchError(`Failed to launch scout ${scout.agent_id}: ${launchResult.reason ?? 'unknown error'}`);
  }

  const launchedAt = new Date().toISOString();
  const sessionToken = getAgent(stateDir, scout.agent_id)?.session_token ?? scout.session_token ?? null;
  if (!sessionToken) {
    await adapter.stop(launchResult.session_handle);
    removeAgent(stateDir, scout.agent_id);
    throw new ScoutLaunchError(`Failed to launch scout ${scout.agent_id}: missing session id after launch`);
  }
  if (!await waitForScoutReady(stateDir, scout.agent_id, sessionToken, scout)) {
    await adapter.stop(launchResult.session_handle);
    removeAgent(stateDir, scout.agent_id);
    if (hasSessionStartHook(scout.provider, 'sandbox')) {
      throw new ScoutLaunchError(`Failed to brief scout ${scout.agent_id}: scout session did not become ready in time (no session-start hook record)`);
    }
    // A read-only Codex scout in a project cannot reach the control socket, so it never reports (task 230).
    const hint = scout.provider === 'codex' && (prepared.sandbox_network === 'restricted' || prepared.sandbox_network === 'open')
      ? `in a project a sandboxed ${scout.provider} scout reports through the control socket, which it cannot reach here`
        + ' (request a claude scout) — see docs/configuration.md → Execution Modes'
      : null;
    throw new ScoutLaunchError(`Failed to brief scout ${scout.agent_id}: scout did not report for duty in time`, hint);
  }
  const contextLines = [
    prepared.run_id ? `linked_run_id: ${prepared.run_id}` : null,
    prepared.task_ref ? `linked_task_ref: ${prepared.task_ref}` : null,
  ].filter(Boolean).join('\n');
  const brief = renderTemplate('scout-brief-v1.txt', {
    agent_id: scout.agent_id,
    provider: scout.provider,
    objective: prepared.objective,
    context_lines: contextLines,
    working_directory: workingDirectory,
    use_web: prepared.use_web ? 'yes' : 'no',
    scope_paths: scopeLines(prepared.scope_paths),
  });
  try {
    await adapter.send(launchResult.session_handle, brief);
  } catch (error) {
    await adapter.stop(launchResult.session_handle);
    removeAgent(stateDir, scout.agent_id);
    throw new ScoutLaunchError(`Failed to brief scout ${scout.agent_id}: ${(error as Error)?.message ?? 'unknown error'}`);
  }

  return {
    agent_id: scout.agent_id,
    role: 'scout',
    provider: scout.provider,
    status: scout.status,
    objective: prepared.objective,
    run_id: prepared.run_id,
    task_ref: prepared.task_ref,
    use_web: prepared.use_web,
    scope_paths: prepared.scope_paths,
    working_directory: workingDirectory,
    launched_at: launchedAt,
    session_handle: launchResult.session_handle,
  };
}

/**
 * Launch a prepared scout in the background (the coordinator's path) and record
 * the outcome as `scout_launched` or `scout_launch_failed`. Never rejects.
 */
export function launchScoutInBackground(stateDir: string, prepared: PreparedScout, actorId: string): Promise<void> {
  const agentId = prepared.scout.agent_id;
  const base = { ts: new Date().toISOString(), actor_type: 'coordinator', actor_id: 'coordinator', agent_id: agentId } as const;
  const common = { requested_by: actorId, provider: prepared.scout.provider };
  const emit = (event: OrcEventInput) => {
    try {
      appendSequencedEvent(stateDir, event);
    } catch { /* the event log is best effort here; the scout stays listed or removed as launched */ }
  };
  return launchScout(stateDir, prepared).then(
    (launched) => emit({ ...base, event: 'scout_launched',
      payload: { ...common, working_directory: launched.working_directory, session_handle: launched.session_handle } }),
    (error: unknown) => {
      const failure = error instanceof ScoutLaunchError ? error : null;
      // An unexpected failure leaves a registered scout without a session; remove it so it is not listed forever.
      if (!failure) { try { removeAgent(stateDir, agentId); } catch { /* already gone */ } }
      emit({ ...base, event: 'scout_launch_failed', payload: { ...common,
        reason: failure?.reason ?? (error as Error)?.message ?? 'unknown error', ...(failure?.hint ? { hint: failure.hint } : {}) } });
    },
  );
}

/** A scout's report spans a few kilobytes of TUI output; read well past the default 8 KiB tail. */
const SCOUT_OUTPUT_BYTES = 64 * 1024;
const MARKER_PREFIX = String.raw`^[^\w\n]*`;
const REPORT_START = new RegExp(`${MARKER_PREFIX}SCOUT_REPORT[ \t]*$`);
const REPORT_END = new RegExp(`${MARKER_PREFIX}SCOUT_REPORT_END[ \t]*$`);
const REPORT_HEADERS = ['findings', 'likely_cause', 'recommended_action'].map((header) => new RegExp(`${MARKER_PREFIX}${header}:`, 'm'));

/** Remove the indentation every non-blank line shares (a TUI indents its output). */
function dedent(lines: string[]): string {
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length));
  return Number.isFinite(indent) ? lines.map((line) => line.slice(indent)).join('\n') : lines.join('\n');
}

/**
 * Find a scout's final SCOUT_REPORT block in its session output. Markers count
 * only on their own line (a prompt glyph or indentation may precede them), and
 * a block counts only with all three report headers and no `<placeholder>`
 * from the echoed template, so quoted examples and the template are ignored.
 * `truncated` means the last end marker is a real report's whose start fell
 * outside the output read; the echoed template's own end marker (its
 * `<placeholder>` lines just before it) never counts, so a scout whose tail
 * begins inside the template is still `running`.
 */
export function extractScoutReport(output: string): { report: string | null; truncated: boolean } {
  let start: number | null = null;
  let report: string | null = null;
  let truncated = false;
  const lines = output.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (REPORT_START.test(line)) { start = index; return; }
    if (!REPORT_END.test(line)) return;
    if (start === null) {
      truncated = !lines.slice(Math.max(0, index - 3), index).join('\n').includes('<concrete next step');
      return;
    }
    truncated = false;
    const block = dedent(lines.slice(start + 1, index)).trim();
    start = null;
    if (!block.includes('<what you found') && REPORT_HEADERS.every((header) => header.test(block))) {
      report = block;
      truncated = false;
    }
  });
  return { report, truncated: report === null && truncated };
}

/** The registered scout for an id; a worker or the master is never one. */
export function requireScout(stateDir: string, agentId: unknown): Agent {
  if (typeof agentId !== 'string' || !agentId) throw new InputError('agent_id is required');
  const agent = getAgent(stateDir, agentId);
  if (!agent) throw new NotFoundError(`Scout not found: ${agentId}`);
  if (agent.role !== 'scout') throw new InputError(`${agentId} is not a scout (role: ${agent.role ?? 'unknown'})`);
  return agent;
}

export interface ScoutReportView {
  agent_id: string;
  status: 'running' | 'reported' | 'truncated' | 'ended';
  report: string | null;
  launched_at: string | null;
}

/**
 * Read a scout's report from its session output: `reported` with the block,
 * `truncated` (an end marker without its start, so the report is unreadable),
 * `running`, or `ended` without one.
 */
export async function readScoutReport(stateDir: string, agentId: unknown): Promise<ScoutReportView> {
  const scout = requireScout(stateDir, agentId);
  const launchedAt = scout.registered_at ?? null;
  if (!scout.session_handle) return { agent_id: scout.agent_id, status: 'ended', report: null, launched_at: launchedAt };
  const adapter = createAdapter(scout.provider);
  const { report, truncated } = extractScoutReport(adapter.getOutputTail(scout.session_handle, SCOUT_OUTPUT_BYTES) ?? '');
  const status = report ? 'reported' : truncated ? 'truncated'
    : (await adapter.heartbeatProbe(scout.session_handle)) ? 'running' : 'ended';
  return { agent_id: scout.agent_id, status, report, launched_at: launchedAt };
}

/** Stop a scout's session and remove its registration; only scouts, never workers or the master. */
export async function removeScout(stateDir: string, agentId: unknown) {
  // Removing a scout that is already gone is a no-op, so cleanup can always be called.
  if (typeof agentId === 'string' && agentId && !getAgent(stateDir, agentId)) return { agent_id: agentId, removed: false, reason: 'not_found' };
  const scout = requireScout(stateDir, agentId);
  let stopError: string | null = null;
  if (scout.session_handle) {
    try {
      await createAdapter(scout.provider).stop(scout.session_handle);
    } catch (error) {
      stopError = (error as Error)?.message ?? String(error);
    }
  }
  removeAgent(stateDir, scout.agent_id);
  return { agent_id: scout.agent_id, removed: true, ...(stopError ? { stop_warning: stopError } : {}) };
}
