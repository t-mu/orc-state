export interface RunWorktreeEntry {
  run_id: string;
  task_ref: string;
  agent_id: string;
  branch: string;
  worktree_path: string;
  created_at: string;
  updated_at: string;
}

export interface RunWorktreesState {
  version: '1';
  runs: RunWorktreeEntry[];
}
