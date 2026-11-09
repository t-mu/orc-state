import { renderTemplate } from './templateRender.ts';
import { hasSessionStartHook, isSupportedProvider, type ProviderName } from './providers.ts';

const WORKER_BOOTSTRAP_TEMPLATE = 'worker-bootstrap-v2.txt';
const WORKER_BOOTSTRAP_SMOKE_TEMPLATE = 'worker-bootstrap-smoke-v1.txt';
const SCOUT_BOOTSTRAP_TEMPLATE = 'scout-bootstrap-v1.txt';

export const MASTER_BOOTSTRAP_TEMPLATE = 'master-bootstrap-v1.txt';

function assertProvider(provider: string): ProviderName {
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported bootstrap provider: ${provider}`);
  }
  return provider;
}

/**
 * Phase-4 "complete" step text, injected into the worker bootstrap as
 * {{phase_complete_step}}. Task status is runtime-owned in every layout: the
 * coordinator records `done` after merge, and no task spec mirrors it, so the
 * worker never edits a `status:` field. Built with orc_bin/agent_id already
 * interpolated because the outer renderTemplate makes a single pass and will
 * not re-expand placeholders inside an injected value.
 */
function phaseCompleteStep(orcBin: string, agentId: string): string {
  return [
    '  7. Signal complete phase. Task status is runtime-owned — the coordinator records `done` after merge:',
    `       ${orcBin} progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=${agentId}`,
    '       - Do NOT edit the `status:` field of any task spec; commit only the changes the task asks for, never orchestration state',
    `       - Do not call \`${orcBin} task-mark-done\` from the worker session`,
  ].join('\n');
}

/**
 * How the session becomes ready, injected as {{session_ready_step}}. A provider
 * with a session-start hook reports ready by itself, so its agent is never told
 * to run report-for-duty; the others are.
 */
function sessionReadyVars(provider: string, orcBin: string, agentId: string, sessionId: string, awaiting: string) {
  if (hasSessionStartHook(provider)) {
    return {
      session_ready_step: `This session reports itself ready when it starts (session-start hook); you run no command for that. Wait for the ${awaiting}.`,
    };
  }
  const command = `${orcBin} report-for-duty --agent-id=${agentId} --session-id=${sessionId}`;
  return {
    session_ready_step: `Before waiting for the ${awaiting}, report that this exact session is ready:\n\n  ${command}`,
  };
}

export type ReviewLevel = 'none' | 'light' | 'full';
export type MergeStrategy = 'direct' | 'pr';

/** What a worker needs to know about its own run to get only its own workflow. */
export interface WorkerTaskWorkflow {
  reviewLevel?: ReviewLevel | null | undefined;
  mergeStrategy?: MergeStrategy | null | undefined;
}

/**
 * Providers whose CLI loads the repository's agent guide by itself: Codex reads
 * AGENTS.md, Claude reads CLAUDE.md (which in this layout imports AGENTS.md).
 * Gemini reads GEMINI.md only, so its worker is told to read AGENTS.md.
 */
const AGENT_GUIDE_AUTOLOAD_PROVIDERS: ReadonlySet<string> = new Set<ProviderName>(['claude', 'codex']);

function repoGuideLine(provider: string): string {
  const contents = 'commit format, verification checklist, what to avoid';
  return AGENT_GUIDE_AUTOLOAD_PROVIDERS.has(provider)
    ? `If the repository has an AGENTS.md (loaded into your context with the repo), follow its repo rules: ${contents}.`
    : `Before starting, read AGENTS.md at the worktree root if it exists: it holds the repo rules (${contents}).`;
}

function reviewerConstraints(orcBin: string, agentId: string): string {
  return [
    '          --- REVIEWER CONSTRAINTS (read this before doing anything) ---',
    '          You are a code reviewer sub-agent operating at MAX_DEPTH=1.',
    '          Your only role is to review the diff provided above — do not explore',
    '          the codebase independently. Identify any issues and return findings',
    '          as text (or "approved" if none).',
    '',
    '          You MUST call before returning:',
    `            ${orcBin} review-submit --run-id=<run_id> --agent-id=${agentId} \\`,
    '              --reviewer=<reviewer_label> --outcome=<approved|findings> --reason="<findings text>"',
    '          <reviewer_label> must be your own label (filled in above); keep --agent-id',
    "          exactly as written: it is the worker's id, not yours.",
    '          This is the ONLY orc command you may call.',
    '',
    '          You MUST NOT call any of the following commands:',
    '            orc run-start, orc run-heartbeat, orc run-work-complete,',
    '            orc run-finish, orc run-fail, orc run-input-request,',
    '            orc task-mark-done, orc delegate, orc task-reset,',
    '            orc task-unblock, orc kill-all',
    '          You MUST NOT write to orc state (runtime.db or any other file in the project state directory).',
    '          You MUST NOT spawn further sub-agents or delegates.',
    '          You MUST NOT make any file edits, commits, or git operations.',
    '',
    '          Wrap your entire output in this block (no text outside it):',
    '            REVIEW_FINDINGS',
    '            verdict: approved | findings',
    '',
    '            <one finding per issue, or "No issues found.">',
    '            REVIEW_FINDINGS_END',
    '          --- END REVIEWER CONSTRAINTS ---',
  ].join('\n');
}

/**
 * Step 6 for the run's review_level only, injected as {{review_step}}. The
 * level is a task field (default `full`), not something the worker can read
 * from the pinned spec, so the bootstrap states it.
 */
function reviewStep(level: ReviewLevel, orcBin: string, agentId: string): string {
  if (level === 'none') {
    return [
      '  6. Self-review (review_level none): read your diff (`git diff main...HEAD`) against the acceptance criteria.',
      '     Fix any gap in a fixup commit and re-check; if a gap is unresolvable, call run-fail with the reason.',
    ].join('\n');
  }
  const spawn = level === 'light'
    ? [
      '  6. Review (review_level light): spawn ONE reviewer sub-agent (agents/reviewer.md) with:',
      '       - the acceptance criteria for this task',
      '       - the full diff, not just file names: `git diff --stat --patch main...HEAD`',
      '       - the REVIEWER CONSTRAINTS block below, with <reviewer_label> replaced by `reviewer`',
    ]
    : [
      '  6. Review (review_level full): spawn TWO independent reviewer sub-agents (critic + integrator) with:',
      '       - the acceptance criteria for this task',
      '       - the full diff, not just file names: `git diff --stat --patch main...HEAD`',
      '       - the REVIEWER CONSTRAINTS block below, with <reviewer_label> replaced by `critic`',
      '         for one reviewer and `integrator` for the other (reviews with the same label replace each other)',
    ];
  return [
    ...spawn,
    '',
    reviewerConstraints(orcBin, agentId),
    '',
    `     Read the reviews: ${orcBin} review-read --run-id=<run_id>`,
    '     It exits 0 whatever the reviews say (inspect the outcomes); non-zero means they could not be read, so retry shortly.',
    '     A reviewer that never submitted, or whose output lacks REVIEW_FINDINGS_END, is non-responsive. If it submitted and its',
    '     conversation is still active, send it once: "Your review-submit was received but the structured REVIEW_FINDINGS block',
    '     is missing from your output. Emit only the block now." Otherwise proceed with the reviews that were submitted.',
    '     One review round only: address all findings in a fixup commit, then proceed.',
  ].join('\n');
}

/**
 * Steps 8 onward for the run's merge mode only, injected as {{finish_steps}}:
 * direct mode rebases and waits for the coordinator's merge, PR mode waits for
 * PR_REVIEW (which carries the PR loop, see prReviewSteps). Each also says how
 * to follow the other mode's messages, since a task's merge mode is revisable.
 */
function finishSteps(mode: MergeStrategy, orcBin: string, agentId: string): string {
  const ids = `--run-id=<run_id> --agent-id=${agentId}`;
  const workComplete = `${orcBin} run-work-complete ${ids}`;
  const finalizeSignal = `${orcBin} progress --event=phase_started --phase=finalize ${ids}`;
  const runFinish = `${orcBin} run-finish ${ids}`;
  if (mode === 'direct') {
    return [
      '  8. Rebase onto main, resolving conflicts iteratively and never aborting:',
      '       git rebase main   # on conflict: resolve → git add <file> → git rebase --continue, until clean',
      '     Fail the run only if a conflict is truly unresolvable. Then rerun `npm test`; it must pass.',
      '  9. Hand off; implementation and review are done:',
      `       ${workComplete}`,
      '  10. Signal finalize and wait in this session for the coordinator:',
      `       ${finalizeSignal}`,
      '       - A PR_REVIEW message (the merge mode changed): follow the PR loop it carries.',
      '       - Told to perform a finalize rebase: rebase in this worktree, verify/commit as instructed, call',
      '         run-work-complete again and keep waiting.',
      '       - Told finalization succeeded or the session can stop, or no follow-up arrives: end the run. Only after',
      '         run-work-complete, never speculatively:',
      `           ${runFinish}`,
    ].join('\n');
  }
  return [
    '  8. Hand off; implementation and review are done (no rebase yet: the PR loop rebases):',
    `       ${workComplete}`,
    '  9. Signal finalize and wait in this session for a PR_REVIEW message; it carries the PR loop to follow:',
    `       ${finalizeSignal}`,
    '     If FINALIZE_REBASE or FINALIZE_SUCCESS arrives instead (the merge mode changed), follow it; after',
    `     FINALIZE_SUCCESS end the run: ${runFinish}`,
  ].join('\n');
}

/**
 * The PR loop, carried by the PR_REVIEW message rather than the bootstrap so it
 * follows the merge mode and review level the coordinator finalizes with, even
 * when the task was edited after the worker started. Built with orc_bin and
 * agent_id interpolated (single-pass renderTemplate).
 */
export function prReviewSteps(level: ReviewLevel, orcBin: string, agentId: string): string {
  const ids = `--run-id=<run_id> --agent-id=${agentId}`;
  const fail = (reason: string) => `${orcBin} run-fail ${ids} --reason="${reason}" --policy=requeue`;
  const review = level === 'none'
    ? [
      '  B. Review-fix loop, max 3 iterations (review_level none): self-review `git diff origin/main...HEAD` against the',
      '     acceptance criteria; if all are met exit the loop, else fix, commit and loop. Past 3:',
    ]
    : [
      `  B. Review-fix loop, max 3 iterations (review_level ${level}): ${level === 'light'
        ? 'spawn ONE reviewer sub-agent (agents/reviewer.md), label `reviewer`,'
        : 'spawn TWO reviewer sub-agents, labels `critic` and `integrator`,'}`,
      '     each given the acceptance criteria, `git diff --stat --patch origin/main...HEAD` and the REVIEWER CONSTRAINTS',
      '     below with <reviewer_label> replaced by its label.',
      '',
      reviewerConstraints(orcBin, agentId),
      '',
      `     Collect with ${orcBin} review-read --run-id=<run_id>; if all approved exit the loop, else fix, commit and loop. Past 3:`,
    ];
  return [
    'Follow these steps in order:',
    '  A. Rebase: git fetch origin main && git rebase origin/main',
    '     Resolve conflicts iteratively (resolve → git add <file> → git rebase --continue). If unresolvable:',
    `       ${fail('unresolvable rebase conflict')}`,
    ...review,
    `       ${fail('review-fix loop exceeded 3 iterations')}`,
    '  C. Pre-push rebase: git fetch origin main && git rebase origin/main; `npm test` — on failure back to B (counts against the limit).',
    '  D. CI loop, max 3 iterations: git push --force-with-lease, then',
    `     ${orcBin} pr-status <pr_ref> --wait; if passing exit the loop, else diagnose, fix, commit and loop. Past 3:`,
    `       ${fail('ci-fix loop exceeded 3 iterations')}`,
    `  E. Signal ready: ${orcBin} run-work-complete ${ids}`,
    '     Wait for the coordinator to merge the PR and send the run-finish signal; when it arrives:',
    `       ${orcBin} run-finish ${ids}`,
  ].join('\n');
}

function workerVars(provider: string, orcBin: string, agentId: string, sessionId: string, workflow: WorkerTaskWorkflow) {
  const reviewLevel = workflow.reviewLevel ?? 'full';
  const mergeStrategy = workflow.mergeStrategy ?? 'direct';
  return {
    agent_id: agentId,
    orc_bin: orcBin,
    provider,
    session_id: sessionId,
    review_level: reviewLevel,
    merge_strategy: mergeStrategy,
    repo_guide: repoGuideLine(provider),
    review_step: reviewStep(reviewLevel, orcBin, agentId),
    phase_complete_step: phaseCompleteStep(orcBin, agentId),
    finish_steps: finishSteps(mergeStrategy, orcBin, agentId),
    ...sessionReadyVars(provider, orcBin, agentId, sessionId, 'TASK_START'),
  };
}

function renderBootstrap(template: string, provider: string, agentId: string): string {
  const awaiting = template === SCOUT_BOOTSTRAP_TEMPLATE ? 'SCOUT_BRIEF' : 'TASK_START';
  return renderTemplate(template, {
    agent_id: agentId,
    orc_bin: 'orc',
    provider,
    session_id: 'session-id-unset',
    ...sessionReadyVars(provider, 'orc', agentId, 'session-id-unset', awaiting),
  });
}

export type WorkerBootstrapProfile = 'default' | 'smoke';

export interface WorkerBootstrapOptions extends WorkerTaskWorkflow {
  workerBootstrapProfile?: WorkerBootstrapProfile;
}

// The smoke profile keeps its own hardcoded Phase 4 step. It is a deterministic
// lifecycle smoke-test fixture, not a production path. It has no
// {{phase_complete_step}} placeholder, so the injected var is simply unused for
// this profile.
function resolveWorkerTemplate(role: string, workerBootstrapProfile: WorkerBootstrapProfile = 'default'): string {
  if (role === 'worker' && workerBootstrapProfile === 'smoke') {
    return WORKER_BOOTSTRAP_SMOKE_TEMPLATE;
  }
  return WORKER_BOOTSTRAP_TEMPLATE;
}

export function getWorkerBootstrap(provider: string, agentId: string = 'worker', workflow: WorkerTaskWorkflow = {}): string {
  const resolvedProvider = assertProvider(provider);
  return renderTemplate(WORKER_BOOTSTRAP_TEMPLATE, workerVars(resolvedProvider, 'orc', agentId, 'session-id-unset', workflow));
}

export function getScoutBootstrap(provider: string): string;
export function getScoutBootstrap(provider: string, agentId: string): string;
export function getScoutBootstrap(provider: string, agentId: string = 'scout'): string {
  const resolvedProvider = assertProvider(provider);
  return renderBootstrap(SCOUT_BOOTSTRAP_TEMPLATE, resolvedProvider, agentId);
}

export function getMasterBootstrap(provider: string): string;
export function getMasterBootstrap(provider: string, agentId: string): string;
export function getMasterBootstrap(provider: string, agentId: string = 'master'): string {
  const resolvedProvider = assertProvider(provider);
  return renderBootstrap(MASTER_BOOTSTRAP_TEMPLATE, resolvedProvider, agentId);
}

/**
 * Build the bootstrap prompt for a worker session.
 * Master agents keep their existing bootstrap path; all non-master roles use
 * the task-scoped worker bootstrap contract.
 */
export function buildSessionBootstrap(agentId: string, provider: string, role: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string, sessionId: string): string;
export function buildSessionBootstrap(agentId: string, provider: string, role: string, orcBin: string, sessionId: string, options: WorkerBootstrapOptions): string;
export function buildSessionBootstrap(
  agentId: string,
  provider: string,
  role: string,
  orcBin: string = 'orc',
  sessionId: string = 'session-id-unset',
  options: WorkerBootstrapOptions = {},
): string {
  if (role === 'master') return getMasterBootstrap(provider, agentId);
  if (role === 'scout') {
    return renderTemplate(SCOUT_BOOTSTRAP_TEMPLATE, {
      agent_id: agentId,
      orc_bin: orcBin,
      provider,
      session_id: sessionId,
      ...sessionReadyVars(provider, orcBin, agentId, sessionId, 'SCOUT_BRIEF'),
    });
  }
  return renderTemplate(
    resolveWorkerTemplate(role, options.workerBootstrapProfile ?? 'default'),
    workerVars(provider, orcBin, agentId, sessionId, options),
  );
}
