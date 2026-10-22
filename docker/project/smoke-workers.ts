#!/usr/bin/env node
/** Opt-in image smoke: two provider worker PTYs in the same container. */
import { createTmuxAdapter } from '../../adapters/tmux.ts';

process.env.PATH = `/opt/orc-state/test-fixtures/bin:${process.env.PATH ?? ''}`;
const adapter = createTmuxAdapter({ provider: 'gemini' });
const handles: string[] = [];
try {
  for (const agentId of ['smoke-worker-a', 'smoke-worker-b']) {
    const started = await adapter.start(agentId, { working_directory: process.env.ORC_PROJECT_DIR });
    handles.push(started.session_handle);
  }
  if (new Set(handles).size !== 2 || !handles.every((handle) => adapter.inspectSession(handle).alive)) {
    throw new Error('Two provider worker sessions did not run concurrently');
  }
  console.log('two-provider-workers');
} finally {
  for (const handle of handles) await adapter.stop(handle);
}
