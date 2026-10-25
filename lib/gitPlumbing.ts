/**
 * `-c` flags prepended to every coordinator- and runWorktree-side git
 * invocation that runs against the TARGET repo: direct-mode merge/push and
 * ancestry check (coordinator.ts), worktree add/remove and branch delete
 * (runWorktree.ts), and the PR-mode branch push (gitHosts/github.ts
 * `pushBranch`). They make orchestration plumbing hermetic:
 *
 *  - core.hooksPath=/dev/null — do not run the target repo's hooks. Automated
 *    merges / pushes / worktree operations must not execute product-repo hook
 *    scripts. In project mode this also closes a privilege-escalation
 *    vector: a sandboxed worker cannot get a hook it planted executed by the
 *    UNSANDBOXED coordinator. The worker's `<target>/.git` sandbox grant
 *    already excludes `hooks/` (see adapters/pty.ts), so this is defense in
 *    depth from the coordinator side.
 *  - core.fsmonitor=false — never spawn or trust an fsmonitor daemon during a
 *    coordinator-side git operation.
 *
 * These flags MUST appear before the git subcommand, so spread them at the
 * front of the args array: `spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, 'merge', ...])`.
 *
 * Behaviour-preserving in the single-repo (self-orchestration) layout: none of
 * the affected ops run installed hooks there, and worker commits — which DO run
 * the repo's pre-commit hook — are not touched by these flags.
 */
export const HERMETIC_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];
