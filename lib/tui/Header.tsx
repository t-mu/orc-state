import { Box, Text } from 'ink';
import { formatProjectIdentity, WAITING_INPUT_ANSWER_HINT } from './format.ts';
import { describeConnection, type TuiProjectView, type TuiStatus } from './status.ts';

const CONNECTION_COLOR: Record<TuiProjectView['connection'], string> = {
  running: 'green',
  connecting: 'cyan',
  stopped: 'yellow',
  unreachable: 'red',
  incompatible: 'red',
};

/**
 * `updatedAt` is when the status was loaded, so animation renders leave the header unchanged.
 * `project` is the watched project; without one (not registered) only `status` is shown.
 * `others` are the other watched projects, listed on one line with their connection.
 * `notice` replaces the coordinator line when `project` is null (why nothing is shown).
 */
export function Header({ status, banner, updatedAt, project = null, others = [], notice = null }: {
  status: TuiStatus;
  banner: string | null;
  updatedAt: string;
  project?: TuiProjectView | null;
  others?: TuiProjectView[];
  /** Shown in place of the coordinator line when there is no watched project. */
  notice?: string | null;
}) {
  const taskCounts = status.tasks.counts;
  const waitingCount = status.waiting_input?.length ?? 0;
  const identity = status.project ?? (project ? { id: project.project_id, name: project.name, target_repo_root: project.target_repo_root } : null);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {banner != null ? <Text>{banner}</Text> : null}
      <Text bold wrap="truncate">{formatProjectIdentity(identity)}</Text>
      {project
        ? (
            <Text wrap="truncate">
              coordinator: <Text color={CONNECTION_COLOR[project.connection]}>{describeConnection(project)}</Text>
              {project.stale ? <Text dimColor> (showing last known status)</Text> : null}
            </Text>
          )
        : notice ? <Text color="yellow" wrap="truncate">{notice}</Text> : null}
      <Text dimColor wrap="truncate">
        capacity: {status.worker_capacity.used_slots}/{status.worker_capacity.configured_slots}
        {' | '}todo: {taskCounts.todo ?? 0}
        {' | '}active: {status.claims.in_progress}
        {' | '}updated: {updatedAt}
      </Text>
      {others.length > 0
        ? <Text dimColor wrap="truncate">other projects: {others.map((other) => `${other.name} ${other.connection}`).join(' · ')}</Text>
        : null}
      {waitingCount > 0
        ? (
            <Text wrap="truncate">
              <Text bold inverse color="yellow">{` ${waitingCount} WAITING FOR INPUT `}</Text>
              <Text color="yellow">{` answer: ${WAITING_INPUT_ANSWER_HINT}`}</Text>
            </Text>
          )
        : null}
    </Box>
  );
}
