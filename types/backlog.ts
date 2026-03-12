export type TaskStatus = 'todo' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'released';
export type TaskRef = string;

export interface Task {
  ref: TaskRef;
  title: string;
  status: TaskStatus;
  description?: string;
  task_type?: 'implementation' | 'refactor';
  priority?: 'low' | 'normal' | 'high' | 'critical';
  planning_state?: 'ready_for_dispatch' | 'archived';
  delegated_by?: string;
  parent_task_ref?: TaskRef;
  required_capabilities?: string[];
  depends_on?: TaskRef[];
  acceptance_criteria?: string[];
  attempt_count?: number;
  blocked_reason?: string;
  owner?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Feature {
  ref: string;
  title: string;
  description?: string;
  tasks: Task[];
  created_at?: string;
}

export interface Backlog {
  version: '1';
  next_task_seq?: number;
  epics: Feature[];
}
