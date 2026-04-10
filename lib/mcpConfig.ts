import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

export interface McpMergeResult {
  created: boolean;  // true if .mcp.json didn't exist
  updated: boolean;  // true if orchestrator entry was changed
  path: string;      // absolute path to .mcp.json
}

function runtimeModulePath(relativeTsPath: string, relativeJsPath: string): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath,
    import.meta.url,
  ));
}

export function mergeMcpConfig(
  targetDir: string,
  serverPath: string,
  stateDir: string,
  dryRun: boolean,
): McpMergeResult {
  const configPath = join(targetDir, '.mcp.json');

  let existing: Record<string, unknown> = {};
  let created = false;

  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    created = true;
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};

  const newEntry = {
    command: process.execPath,
    args: [serverPath],
    env: { ORC_STATE_DIR: stateDir },
  };

  const existingEntry = mcpServers['orchestrator'];
  const updated =
    created || JSON.stringify(existingEntry) !== JSON.stringify(newEntry);

  const merged = {
    ...existing,
    mcpServers: {
      ...mcpServers,
      orchestrator: newEntry,
    },
  };

  if (!dryRun) {
    writeFileSync(configPath, JSON.stringify(merged, null, 2));
  }

  return { created, updated, path: configPath };
}

export function defaultServerPath(): string {
  return runtimeModulePath('../mcp/server.ts', '../mcp/server.js');
}
