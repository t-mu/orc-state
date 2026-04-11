import type { ProviderName } from '../lib/providers.ts';

export type TaskStatus = 'todo' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'released' | 'cancelled';
export type TaskRef = string;

export interface Task {
  ref: TaskRef;
  title: string;
  status: TaskStatus;
  description?: string | undefined;
  task_type?: 'implementation' | 'refactor' | undefined;
  priority?: 'low' | 'normal' | 'high' | 'critical' | undefined;
  planning_state?: 'ready_for_dispatch' | 'archived' | undefined;
  delegated_by?: string | undefined;
  parent_task_ref?: TaskRef | undefined;
  required_capabilities?: string[] | undefined;
  required_provider?: ProviderName | undefined;
  model?: string | null | undefined;
  depends_on?: TaskRef[] | undefined;
  acceptance_criteria?: string[] | undefined;
  review_level?: 'none' | 'light' | 'full' | undefined;
  merge_strategy?: 'direct' | 'pr' | undefined;
  attempt_count?: number | undefined;
  requeue_eligible_after?: string | undefined;
  blocked_reason?: string | undefined;
  owner?: string | undefined;
  created_at?: string | undefined;
  updated_at?: string | undefined;
}

export interface Feature {
  ref: string;
  title: string;
  description?: string | undefined;
  tasks: Task[];
  created_at?: string | undefined;
}

export interface Backlog {
  version: '1';
  next_task_seq?: number | undefined;
  features: Feature[];
}
