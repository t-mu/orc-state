/**
 * Codex MCP configuration as `-c` overrides, so a project master does not
 * write `.codex/config.toml` into the target repository. Values are JSON
 * literals, which Codex parses as TOML strings, arrays and inline tables.
 */
export function codexMcpOverrideArgs(serverPath: string, env: Record<string, string>, nodePath = process.execPath, forwardEnv: string[] = []): string[] {
  const table = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
  return [
    '-c', `mcp_servers.orchestrator.command=${JSON.stringify(nodePath)}`,
    '-c', `mcp_servers.orchestrator.args=${JSON.stringify([serverPath])}`,
    '-c', `mcp_servers.orchestrator.env={${table}}`,
    // Variables passed through from Codex's own environment by name, so their values stay off the command line.
    ...(forwardEnv.length ? ['-c', `mcp_servers.orchestrator.env_vars=${JSON.stringify(forwardEnv)}`] : []),
  ];
}
