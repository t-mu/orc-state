const NESTED_PROVIDER_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CODEX_CI',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
] as const;

/**
 * Remove provider/session control env vars that should never leak into nested
 * worker or test child processes. Nested sessions must start as clean,
 * top-level CLIs rather than inheriting the parent agent's sandbox/session.
 */
export function stripNestedProviderEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of NESTED_PROVIDER_ENV_KEYS) delete next[key];
  return next;
}

