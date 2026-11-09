// Text helpers for the TUI. They live here, not in the state-reading modules
// that `orc status` uses, so lib/tui imports nothing but orc-state/client.

/** How an operator answers a waiting worker; equals `WAITING_INPUT_ANSWER_HINT` in lib/waitingInput.ts (format.test.ts). */
export const WAITING_INPUT_ANSWER_HINT = 'orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text>, or ask master';

/** `project: <name> (<id>) → <root>`, as `orc status` prints it for a status without a selection source. */
export function formatProjectIdentity(project: { id: string; name: string; target_repo_root: string } | null): string {
  if (!project) return 'project: (none selected)';
  return `project: ${project.name} (${project.id}) → ${project.target_repo_root}`;
}
