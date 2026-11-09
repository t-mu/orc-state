// Compiled by `npm run typecheck:consumer` against dist/*.d.ts, the way an app sees the package.
import { ControlClient, listProjects, type ProjectListEntry } from 'orc-state/client';
import { ControlClient as RootClient, validateEventObject } from 'orc-state';

export async function firstStatus(): Promise<unknown> {
  const projects: ProjectListEntry[] = listProjects();
  const running = projects.find((project) => project.repo_present && project.coordinator_running);
  if (!running) return null;
  const client: ControlClient = new ControlClient(running.state_dir);
  return client.status();
}

export const rootExports = { RootClient, validateEventObject };
