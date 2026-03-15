#!/usr/bin/env node
/**
 * cli/kill-all.ts
 *
 * Tear down the orchestrator: stop the coordinator, terminate all agent
 * sessions, and clear the registry.
 *
 * Usage:
 *   orc-kill-all [--keep-sessions]
 *
 * --keep-sessions  Skip calling adapter.stop() for each agent; only clear the
 *                  registry. Useful when sessions are already dead but the
 *                  registry is stale.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join }                     from 'node:path';
import { listAgents }               from '../lib/agentRegistry.ts';
import { createAdapter }            from '../adapters/index.ts';
import { STATE_DIR }                from '../lib/paths.ts';
import { atomicWriteJson }          from '../lib/atomicWrite.ts';

const keepSessions = process.argv.includes('--keep-sessions');

// ── Step 1: Kill coordinator ────────────────────────────────────────────────

const pidFile = join(STATE_DIR, 'coordinator.pid');
if (existsSync(pidFile)) {
  let pid: number | undefined;
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as Record<string, unknown> | null | undefined;
    const rawPid = parsed?.pid;
    pid = typeof rawPid === 'number' ? rawPid : undefined;
  } catch { /* stale */ }
  if (pid) {
    try {
      process.kill(pid, 0); // throws ESRCH if already dead
      process.kill(pid, 'SIGTERM');
      // Poll up to 2 s (10 × 200 ms) for the process to exit
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try { process.kill(pid, 0); } catch { break; } // ESRCH = dead, stop polling
      }
      console.log(`✓ Coordinator stopped  (PID ${pid})`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
        try { unlinkSync(pidFile); } catch { /* already gone */ }
        console.log('  Coordinator already stopped');
      } else {
        console.error(`  Warning: could not signal coordinator: ${(e as Error).message}`);
      }
    }
  } else {
    console.log('  Coordinator not running');
  }
} else {
  console.log('  Coordinator not running');
}

// ── Step 2: Stop all agent sessions ────────────────────────────────────────

const agents = listAgents(STATE_DIR);
const liveAgents = agents.filter((a) => a.session_handle);

if (!keepSessions) {
  for (const agent of liveAgents) {
    try {
      const adapter = createAdapter(agent.provider);
      await adapter.stop(agent.session_handle!);
      console.log(`✓ Stopped session for ${agent.agent_id}`);
    } catch (e) {
      console.error(`  Warning: could not stop session for ${agent.agent_id}: ${(e as Error).message}`);
    }
  }
}

// ── Step 3: Clear agent registry ───────────────────────────────────────────

if (existsSync(join(STATE_DIR, 'agents.json'))) {
  atomicWriteJson(join(STATE_DIR, 'agents.json'), { version: '1', agents: [] });
}
console.log(`✓ Cleared ${agents.length} agent(s)`);
