/**
 * Child-process probe for project-mode path resolution. paths.ts resolves the
 * active project once at import, so each scenario runs in a fresh process with
 * its own cwd and environment. Prints one JSON object.
 */
const action = process.argv[2] ?? 'paths';
const paths = await import('../lib/paths.ts');
const result: Record<string, unknown> = {
  project: paths.ACTIVE_PROJECT,
  stateDir: paths.STATE_DIR,
  targetRepoRoot: paths.TARGET_REPO_ROOT,
  worktreesDir: paths.WORKTREES_DIR,
  configFile: paths.ORC_CONFIG_FILE,
  sibling: paths.IS_SIBLING_LAYOUT,
};
if (action === 'launch') {
  const { ensureRunWorktree } = await import('../lib/runWorktree.ts');
  const { normalizeWorkerEnv } = await import('../lib/workerRuntime.ts');
  const { prepareProviderLaunch } = await import('../adapters/pty.ts');
  const { codexAppServerSandboxParams } = await import('../adapters/codexAppServer.ts');
  const { loadWorkerPoolConfig } = await import('../lib/providers.ts');
  const worktree = ensureRunWorktree(paths.STATE_DIR, { runId: 'run-probe', taskRef: 'app/probe', agentId: 'worker-a' });
  const project = paths.ACTIVE_PROJECT!;
  const env = normalizeWorkerEnv({ ORC_STATE_DIR: paths.STATE_DIR }, paths.ORC_PACKAGE_ROOT, { id: project.id, stateDir: paths.STATE_DIR, sessionToken: 'session-probe' });
  const base = { working_directory: worktree.worktree_path, require_git_checkout: true, execution_mode: 'sandbox', env };
  const claude = prepareProviderLaunch('claude', 'worker-a', base);
  const codex = prepareProviderLaunch('codex', 'worker-b', base);
  const { readFileSync } = await import('node:fs');
  const settingsArg = claude.args[claude.args.indexOf('--settings') + 1];
  Object.assign(result, {
    worktree,
    env: { ORC_PROJECT_ID: env.ORC_PROJECT_ID, ORC_HOME: env.ORC_HOME, ORC_REPO_ROOT: env.ORC_REPO_ROOT, ORC_STATE_DIR: env.ORC_STATE_DIR, ORC_SESSION_TOKEN: env.ORC_SESSION_TOKEN, ORC_CONTROL_SOCKET: env.ORC_CONTROL_SOCKET },
    claudeCwd: claude.cwd,
    claudeSettingsPath: settingsArg,
    claudeSandbox: (JSON.parse(readFileSync(settingsArg, 'utf8')) as { sandbox?: unknown }).sandbox,
    codexArgs: codex.args,
    structured: codexAppServerSandboxParams({ execution_mode: 'sandbox', env }, worktree.worktree_path),
    maxWorkers: loadWorkerPoolConfig().max_workers,
  });
}
console.log(JSON.stringify(result));

export {};
