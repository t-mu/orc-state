import { resolve } from 'node:path';
import { resolveRepoRoot } from './repoRoot.ts';

export const STATE_DIR = process.env.ORCH_STATE_DIR
  ? resolve(process.env.ORCH_STATE_DIR)
  : resolve(resolveRepoRoot(), '.orc-state');

export const EVENTS_FILE = resolve(STATE_DIR, 'events.jsonl');
// Config lives at repo root when using the default layout (.orc-state/ inside repo root).
// When ORCH_STATE_DIR is overridden to a custom path, keep the config alongside the state dir.
export const ORCHESTRATOR_CONFIG_FILE = process.env.ORC_CONFIG_FILE
  ? resolve(process.env.ORC_CONFIG_FILE)
  : process.env.ORCH_STATE_DIR
    ? resolve(STATE_DIR, 'orchestrator.config.json')
    : resolve(STATE_DIR, '..', 'orchestrator.config.json');
export const RUN_WORKTREES_FILE = resolve(STATE_DIR, 'run-worktrees.json');

export const WORKTREES_DIR = process.env.ORC_WORKTREES_DIR
  ? resolve(process.env.ORC_WORKTREES_DIR)
  : resolve(resolveRepoRoot(), '.worktrees');

export const BACKLOG_DOCS_DIR = process.env.ORC_BACKLOG_DIR
  ? resolve(process.env.ORC_BACKLOG_DIR)
  : resolve(resolveRepoRoot(), 'backlog');
