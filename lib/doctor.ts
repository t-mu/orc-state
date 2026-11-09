/**
 * lib/doctor.ts — the health checks behind `orc doctor` and MCP `doctor`.
 */
import { execSync } from 'node:child_process';
import { ACTIVE_PROJECT, NO_PROJECT_MESSAGE, TARGET_REPO_ROOT, WORKTREES_DIR } from './paths.ts';
import type { ActiveProject } from './projectContext.ts';
import { checkProjectHealth } from './projectHealth.ts';
import { isBinaryAvailable, PROVIDER_BINARIES, PROVIDER_PACKAGES } from './binaryCheck.ts';
import { readAgents, readClaims } from './stateReader.ts';
import { validateStateDir, validateMemoryDb } from './stateValidation.ts';
import { detectLifecycleIssues, type LifecycleIssue } from './lifecycleDiagnostics.ts';
import { claimedRunStartupAnchor } from './runActivity.ts';
import { getOrphanedClaims } from './claimDiagnostics.ts';
import { checkSandboxControlSocket, checkSandboxDependencies } from './sandboxDeps.ts';
import { inspectRuntimeSchema } from './runtimeSchema.ts';
import { coordinatorSchemaProblems, inspectSchemaRange, type SchemaRange } from './schemaCompat.ts';
import type { ControlHealth } from './controlServer.ts';
import { coordinatorPidFileProblem } from './coordinatorLiveness.ts';
import { ControlClient, controlSocketFromEnv } from './controlClient.ts';
import { staleCodeWarning } from './codeIdentity.ts';
import { checkTmux } from '../adapters/tmux.ts';
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';

export interface DoctorOptions {
  /** The project; defaults to the active one. Null runs the checks with no project selected. */
  project?: ActiveProject | null;
  targetRepoRoot?: string;
  worktreesDir?: string;
  staleStartThresholdMs?: number;
  staleProgressThresholdMs?: number;
  nowMs?: number;
}

export interface ProviderBinaryCheck { ok: boolean; binary: string; package: string | null; detail: string }
export interface StaleActiveClaim {
  run_id: string; task_ref: string; agent_id: string; claim_state: string;
  idle_seconds: number; threshold_seconds: number; hint: string;
}

export interface DoctorChecks {
  project: ReturnType<typeof checkProjectHealth> | null;
  projectSelection: { ok: false; message: string } | null;
  gitRepo: boolean;
  providerBinaries: Record<string, ProviderBinaryCheck>;
  staleLinkedWorkers: Array<{ agent_id: string; status: string; session_handle: string; note: string }>;
  orphanedActiveClaims: ReturnType<typeof getOrphanedClaims>;
  staleActiveClaims: StaleActiveClaim[];
  lifecycleIssues: LifecycleIssue[];
  stateErrors: string[];
  sandboxDependencies: ReturnType<typeof checkSandboxDependencies>;
  sandboxControlSocket: ReturnType<typeof checkSandboxControlSocket>;
  memoryHealth: ReturnType<typeof validateMemoryDb>;
  runtimeSchema: ReturnType<typeof inspectRuntimeSchema>;
  coordinatorLock: { problem: string | null };
  /** A warning only: never part of `ok`. Null when no coordinator answers or its code is current. */
  coordinatorCode: { warning: string | null };
  /** Each database the running coordinator's schema support does not cover; `coordinator` is null when none answers. */
  coordinatorSchema: {
    ok: boolean; problems: string[];
    coordinator: Pick<ControlHealth, 'schema_version'> & Partial<Pick<ControlHealth, 'schemas'>> | null;
    databases: { events: SchemaRange | null; runtime: SchemaRange | null };
  };
  tmux: ReturnType<typeof checkTmux>;
}

export interface DoctorReport {
  ok: boolean;
  registered_workers: number;
  active_claims: number;
  checks: DoctorChecks;
}

/** One line per check: the compact view MCP `doctor` returns. */
export interface DoctorCheck { name: string; ok: boolean; detail: string }

/** Runs every `orc doctor` check against `stateDir`. */
export async function runDoctor(stateDir: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const project = options.project === undefined ? ACTIVE_PROJECT : options.project;
  const staleStartThresholdMs = options.staleStartThresholdMs ?? 5 * 60 * 1000;
  const staleProgressThresholdMs = options.staleProgressThresholdMs ?? 20 * 60 * 1000;
  const nowMs = options.nowMs ?? Date.now();

  // A project's Git checks run against its registered target, wherever the command is invoked.
  // Same order as ever: later reads (the lifecycle and schema checks) can create files the state check looks for.
  const gitRepo = isGitRepo(project ? (options.targetRepoRoot ?? TARGET_REPO_ROOT) : undefined);
  const stateErrors = validateStateDir(stateDir);
  const projectHealth = project ? checkProjectHealth(project, stateDir, { worktreesDir: options.worktreesDir ?? WORKTREES_DIR }) : null;
  const agents: Agent[] = safeRead(() => readAgents(stateDir).agents, []);
  const claims: Claim[] = safeRead(() => readClaims(stateDir).claims, []);
  const sandboxDependencies = checkSandboxDependencies();
  const sandboxControlSocket = checkSandboxControlSocket({ project: Boolean(project) });
  const memoryHealth = validateMemoryDb(stateDir);
  const runtimeSchema = inspectRuntimeSchema(stateDir);
  const coordinatorLock = { problem: coordinatorPidFileProblem(stateDir) };
  const health = await coordinatorHealth(stateDir);
  const coordinatorCode = { warning: health ? staleCodeWarning(health) : null };
  const coordinatorSchema = checkCoordinatorSchema(stateDir, health);
  // Every provider terminal session (master and workers) runs in tmux.
  const tmux = checkTmux();

  const providerBinaries: Record<string, ProviderBinaryCheck> = {};
  for (const provider of new Set(agents.map((a) => a.provider))) {
    if (provider) providerBinaries[provider] = checkProviderBinary(provider);
  }

  const checks: DoctorChecks = {
    project: projectHealth,
    // Only a registered project runs.
    projectSelection: project ? null : { ok: false, message: NO_PROJECT_MESSAGE },
    gitRepo,
    providerBinaries,
    staleLinkedWorkers: agents
      .filter((agent) => agent.session_handle && agent.status === 'offline')
      .map((agent) => ({
        agent_id: agent.agent_id,
        status: agent.status,
        session_handle: agent.session_handle!,
        note: 'offline worker still has session_handle',
      })),
    orphanedActiveClaims: getOrphanedClaims(agents, claims),
    staleActiveClaims: staleActiveClaims(claims, nowMs, staleStartThresholdMs, staleProgressThresholdMs),
    lifecycleIssues: detectLifecycleIssues(stateDir),
    stateErrors,
    sandboxDependencies,
    sandboxControlSocket,
    memoryHealth,
    runtimeSchema,
    coordinatorLock,
    coordinatorCode,
    coordinatorSchema,
    tmux,
  };

  return {
    ok: doctorCheckList(checks).every((check) => check.ok),
    registered_workers: agents.length,
    active_claims: claims.filter((c) => ['claimed', 'in_progress'].includes(c.state)).length,
    checks,
  };
}

/** Each check as `{ name, ok, detail }` with one line of detail; `orc doctor`'s `ok` is all of them passing. */
export function doctorCheckList(checks: DoctorChecks): DoctorCheck[] {
  const count = (items: unknown[], noun: string, describe: (item: never) => string) =>
    items.length === 0 ? '' : `${items.length} ${noun}: ${items.map((item) => describe(item as never)).join('; ')}`;
  const providers = Object.entries(checks.providerBinaries);
  const sd = checks.sandboxDependencies;
  const project = checks.project;
  return [
    { name: 'project', ok: project?.ok ?? true, detail: project ? [...project.errors, ...project.warnings].join('; ') : '' },
    { name: 'project_selection', ok: checks.projectSelection === null, detail: checks.projectSelection?.message ?? '' },
    { name: 'git_repo', ok: checks.gitRepo, detail: checks.gitRepo ? '' : 'not inside a git repository' },
    {
      name: 'provider_binaries',
      ok: providers.every(([, check]) => check.ok),
      detail: providers.filter(([, check]) => !check.ok).map(([provider, check]) => `${provider}: ${check.detail}`).join('; '),
    },
    { name: 'stale_linked_workers', ok: checks.staleLinkedWorkers.length === 0,
      detail: count(checks.staleLinkedWorkers, 'offline worker(s) with a session_handle', (w: { agent_id: string }) => w.agent_id) },
    { name: 'orphaned_active_claims', ok: checks.orphanedActiveClaims.length === 0,
      detail: count(checks.orphanedActiveClaims, 'orphaned claim(s)', (c: { run_id: string }) => c.run_id) },
    { name: 'stale_active_claims', ok: checks.staleActiveClaims.length === 0,
      detail: count(checks.staleActiveClaims, 'stale claim(s)', (c: StaleActiveClaim) => `${c.run_id} idle ${c.idle_seconds}s`) },
    { name: 'lifecycle_issues', ok: checks.lifecycleIssues.length === 0,
      detail: count(checks.lifecycleIssues, 'issue(s)', (i: LifecycleIssue) => i.code) },
    { name: 'state_errors', ok: checks.stateErrors.length === 0, detail: checks.stateErrors.join('; ') },
    {
      name: 'sandbox_dependencies',
      ok: sd.ok,
      detail: [sd.skipped ? `skipped (${sd.reason})` : sd.missing.length ? `missing: ${sd.missing.join(', ')}` : '',
        checks.sandboxControlSocket.warning ?? ''].filter(Boolean).join('; '),
    },
    { name: 'memory_health', ok: checks.memoryHealth.ok, detail: checks.memoryHealth.messages.join('; ') },
    { name: 'runtime_schema', ok: checks.runtimeSchema.ok, detail: checks.runtimeSchema.messages.join('; ') },
    { name: 'coordinator_lock', ok: checks.coordinatorLock.problem === null, detail: checks.coordinatorLock.problem ?? '' },
    // A warning only: it never fails the doctor.
    { name: 'coordinator_code', ok: true, detail: checks.coordinatorCode.warning ?? '' },
    { name: 'coordinator_schema', ok: checks.coordinatorSchema.ok, detail: checks.coordinatorSchema.problems.join('; ') },
    { name: 'tmux', ok: checks.tmux.ok, detail: checks.tmux.problem ?? '' },
  ].map((check) => ({ ...check, detail: check.detail.replace(/\s*\n\s*/g, ' ') }));
}

function staleActiveClaims(claims: Claim[], nowMs: number, startMs: number, progressMs: number): StaleActiveClaim[] {
  const stale: StaleActiveClaim[] = [];
  for (const claim of claims) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;
    const anchor = claim.state === 'claimed'
      ? claimedRunStartupAnchor(claim)
      : (claim.last_heartbeat_at ?? claim.started_at ?? claim.claimed_at);
    const idleMs = anchor ? nowMs - new Date(anchor).getTime() : NaN;
    if (Number.isNaN(idleMs)) continue;
    if (claim.input_state === 'awaiting_input') continue;
    if (claim.state === 'claimed' && !claim.task_envelope_sent_at) continue;
    const threshold = claim.state === 'claimed' ? startMs : progressMs;
    if (idleMs < threshold) continue;
    const idleSeconds = Math.round(idleMs / 1000);
    stale.push({
      run_id: claim.run_id,
      task_ref: claim.task_ref,
      agent_id: claim.agent_id,
      claim_state: claim.state,
      idle_seconds: idleSeconds,
      threshold_seconds: Math.round(threshold / 1000),
      hint: claim.state === 'claimed'
        ? `Worker ${claim.agent_id} has not acknowledged run_started for ${idleSeconds}s. Check coordinator logs.`
        : `Worker ${claim.agent_id} has not emitted progress for ${idleSeconds}s. Check coordinator logs.`,
    });
  }
  return stale;
}

function isGitRepo(cwd?: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe', ...(cwd ? { cwd } : {}) });
    return true;
  } catch {
    return false;
  }
}

function checkProviderBinary(provider: string): ProviderBinaryCheck {
  const binary = PROVIDER_BINARIES[provider] ?? provider;
  const packageName = PROVIDER_PACKAGES[provider];
  const ok = isBinaryAvailable(binary);
  const installHint = packageName ? `npm install -g ${packageName}` : null;
  return {
    ok,
    binary,
    package: packageName ?? null,
    detail: ok ? '' : (installHint ? `Run: ${installHint}` : `Binary '${binary}' not found on PATH`),
  };
}

async function coordinatorHealth(stateDir: string): Promise<ControlHealth | null> {
  try {
    return await new ControlClient(stateDir, { timeoutMs: 3_000, socketPath: controlSocketFromEnv() }).health();
  } catch {
    return null; // no coordinator running, or it predates /v1/health
  }
}

/** The running coordinator's schema support against the databases on disk. */
function checkCoordinatorSchema(stateDir: string, health: Partial<ControlHealth> | null): DoctorChecks['coordinatorSchema'] {
  const databases = { events: inspectSchemaRange(stateDir, 'events'), runtime: inspectSchemaRange(stateDir, 'runtime') };
  if (typeof health?.schema_version !== 'number') return { ok: true, problems: [], coordinator: null, databases };
  const coordinator = { schema_version: health.schema_version, ...(health.schemas ? { schemas: health.schemas } : {}) };
  const problems = coordinatorSchemaProblems(coordinator, databases);
  return { ok: problems.length === 0, problems, coordinator, databases };
}

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
