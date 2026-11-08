import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findLiveCoordinator } from './coordinatorLiveness.ts';
import { CONTROL_ENDPOINT_FILE, type ControlEndpoint } from './controlProtocol.ts';
import { ProjectRegistry, projectDataHome } from './projectRegistry.ts';

/** One registered project, with what a client needs to open its control connection. */
export interface ProjectListEntry {
  id: string;
  name: string;
  target_repo_root: string;
  state_dir: string;
  /** Unix socket from the project's `control.json`; null when the state directory or endpoint file is missing or unreadable. */
  control_socket: string | null;
  coordinator_running: boolean;
}

function controlSocket(stateDir: string): string | null {
  try {
    const endpoint = JSON.parse(readFileSync(join(stateDir, CONTROL_ENDPOINT_FILE), 'utf8')) as Partial<ControlEndpoint>;
    return typeof endpoint.path === 'string' && endpoint.path ? endpoint.path : null;
  } catch {
    return null;
  }
}

/** The registry's projects as list entries; a missing or unreadable state directory is not an error. */
export function describeProjects(registry: ProjectRegistry): ProjectListEntry[] {
  return registry.list().map((project) => {
    return {
      id: project.id,
      name: project.name,
      target_repo_root: project.canonicalGitRoot,
      state_dir: project.stateDir,
      control_socket: controlSocket(project.stateDir),
      coordinator_running: findLiveCoordinator(project.stateDir) !== null,
    };
  });
}

/** Every registered project with its control socket and whether its coordinator is up. */
export function listProjects({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ProjectListEntry[] {
  const registry = new ProjectRegistry(projectDataHome(env));
  try {
    return describeProjects(registry);
  } finally {
    registry.close();
  }
}
