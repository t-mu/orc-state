import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMemoryDb, closeMemoryDb,
  storeDrawer, listDrawers,
  searchMemory,
  memoryWakeUp,
  wingFromTaskRef,
  pruneExpiredMemories, pruneByCapacity,
} from './memoryStore.ts';
import { closeAllDatabases } from './eventLog.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-memory-integration-');
});

afterEach(() => {
  closeMemoryDb();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('memory system integration', () => {
  it('store → search round-trip with spatial filtering', () => {
    initMemoryDb(dir);

    storeDrawer(dir, { wing: 'feature-a', hall: 'patterns', room: 'typescript', content: 'typescript strict mode reduces runtime errors' });
    storeDrawer(dir, { wing: 'feature-b', hall: 'patterns', room: 'typescript', content: 'typescript generics improve reusability' });
    storeDrawer(dir, { wing: 'feature-a', hall: 'errors', room: 'database', content: 'sqlite busy_timeout prevents write conflicts' });

    // Search without filter — finds both typescript entries
    const allResults = searchMemory(dir, { query: 'typescript' });
    expect(allResults.length).toBe(2);

    // Search with wing filter — only feature-a
    const filteredResults = searchMemory(dir, { query: 'typescript', wing: 'feature-a' });
    expect(filteredResults.length).toBe(1);
    expect(filteredResults[0]?.wing).toBe('feature-a');
    expect(filteredResults[0]?.snippet).toContain('strict mode');

    // Search with room filter — only database entry
    const dbResults = searchMemory(dir, { query: 'sqlite', room: 'database' });
    expect(dbResults.length).toBe(1);
    expect(dbResults[0]?.room).toBe('database');
  });

  it('duplicate detection prevents re-insertion across the pipeline', () => {
    initMemoryDb(dir);

    const content = 'worker session cleanup must call closeMemoryDb before exit';
    const id1 = storeDrawer(dir, { wing: 'feature-a', hall: 'decisions', room: 'lifecycle', content });
    const id2 = storeDrawer(dir, { wing: 'feature-b', hall: 'patterns', room: 'cleanup', content });

    // Same content → same ID returned, no second row inserted
    expect(id2).toBe(id1);
    expect(listDrawers(dir).length).toBe(1);

    // The single entry is still searchable
    const results = searchMemory(dir, { query: 'cleanup' });
    expect(results.length).toBe(1);
  });

  it('importance-weighted FTS5 ranking orders high-importance first', () => {
    initMemoryDb(dir);

    storeDrawer(dir, { hall: 'h', room: 'r1', content: 'critical deployment failure pattern low detail', importance: 2 });
    storeDrawer(dir, { hall: 'h', room: 'r2', content: 'critical deployment failure pattern high detail', importance: 9 });

    const results = searchMemory(dir, { query: 'critical deployment failure' });
    expect(results.length).toBe(2);
    // Higher importance should rank first
    expect(results[0]?.importance).toBe(9);
    expect(results[1]?.importance).toBe(2);
  });

  it('wake-up returns empty string on fresh DB', () => {
    initMemoryDb(dir);
    const result = memoryWakeUp(dir);
    expect(result).toBe('');
  });

  it('wake-up returns highest-importance memories within budget', () => {
    initMemoryDb(dir);
    for (let i = 1; i <= 20; i++) {
      storeDrawer(dir, { wing: 'w', hall: 'h', room: `r${i}`, content: `memory entry number ${i}`, importance: i % 10 + 1 });
    }

    // tokenBudget=10 → charBudget=40, only a few entries fit
    const result = memoryWakeUp(dir, { tokenBudget: 10 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(40);

    // With generous budget, all 20 entries appear
    const fullResult = memoryWakeUp(dir, { tokenBudget: 10000 });
    expect(fullResult).toContain('memory entry number');
  });

  it('event-driven ingestion pattern creates searchable memories', () => {
    initMemoryDb(dir);

    // Simulate what coordinator.ts does on run_finished
    const taskRef = 'memory-quality/140-integration-tests';
    const agentId = 'orc-1';
    const runId = 'run-20260408130451-aa73';

    const wing = wingFromTaskRef(taskRef);
    expect(wing).toBe('memory-quality');

    storeDrawer(dir, {
      wing,
      hall: 'outcomes', room: 'task-completions',
      content: `Task ${taskRef} completed by ${agentId} (run ${runId})`,
      importance: 5, sourceType: 'event', sourceRef: runId,
    });

    // Simulate a failure ingestion
    storeDrawer(dir, {
      wing: wingFromTaskRef('memory-quality/139-pruning'),
      hall: 'errors', room: 'run-failures',
      content: `Task memory-quality/139-pruning failed (run run-prev): timeout`,
      importance: 8, sourceType: 'event',
    });

    // Both are searchable
    const completionResults = searchMemory(dir, { query: 'completed' });
    expect(completionResults.length).toBe(1);
    expect(completionResults[0]?.wing).toBe('memory-quality');

    const failureResults = searchMemory(dir, { query: 'failed timeout' });
    expect(failureResults.length).toBe(1);
    expect(failureResults[0]?.room).toBe('run-failures');
  });

  it('pruning removes expired drawers', () => {
    initMemoryDb(dir);

    const past = new Date(Date.now() - 5000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    storeDrawer(dir, { hall: 'h', room: 'r', content: 'expired memory content', expiresAt: past });
    storeDrawer(dir, { hall: 'h', room: 'r', content: 'still valid memory content', expiresAt: future });
    storeDrawer(dir, { hall: 'h', room: 'r', content: 'permanent memory content' });

    const deleted = pruneExpiredMemories(dir);
    expect(deleted).toBe(1);

    const remaining = listDrawers(dir);
    expect(remaining.length).toBe(2);
    expect(remaining.every(d => d.content !== 'expired memory content')).toBe(true);
  });

  it('pruning removes over-capacity drawers keeping highest importance', () => {
    initMemoryDb(dir);

    // Fill one room with 10 entries of varying importance
    for (let i = 1; i <= 10; i++) {
      storeDrawer(dir, { wing: 'w', hall: 'h', room: 'crowded', content: `capacity test entry ${i} unique`, importance: i });
    }

    // Prune to max 5
    const deleted = pruneByCapacity(dir, 5);
    expect(deleted).toBe(5);

    const remaining = listDrawers(dir, { wing: 'w', room: 'crowded' });
    expect(remaining.length).toBe(5);

    // Top 5 by importance (10, 9, 8, 7, 6) should remain
    const importances = remaining.map(d => d.importance).sort((a, b) => b - a);
    expect(importances).toEqual([10, 9, 8, 7, 6]);
  });

  it('operations across two stateDirs do not interfere', () => {
    const dir2 = createTempStateDir('orch-memory-isolation-');
    try {
      initMemoryDb(dir);
      initMemoryDb(dir2);

      storeDrawer(dir, { hall: 'h', room: 'r', content: 'dir1 specific content searchable' });
      storeDrawer(dir2, { hall: 'h', room: 'r', content: 'dir2 specific content searchable' });

      const results1 = searchMemory(dir, { query: 'searchable' });
      const results2 = searchMemory(dir2, { query: 'searchable' });

      expect(results1.length).toBe(1);
      expect(results1[0]?.snippet).toContain('dir1');
      expect(results2.length).toBe(1);
      expect(results2[0]?.snippet).toContain('dir2');

      // Wake-up isolation
      const wake1 = memoryWakeUp(dir);
      const wake2 = memoryWakeUp(dir2);
      expect(wake1).toContain('dir1');
      expect(wake1).not.toContain('dir2');
      expect(wake2).toContain('dir2');
      expect(wake2).not.toContain('dir1');
    } finally {
      closeMemoryDb(dir2);
      cleanupTempStateDir(dir2);
    }
  });

  it('full lifecycle: ingest → search → wake-up → expire → prune', () => {
    initMemoryDb(dir);

    const wing = wingFromTaskRef('memory-quality/140-lifecycle');

    // 1. Ingest several memories
    const shortLived = new Date(Date.now() - 1000).toISOString();
    storeDrawer(dir, { wing, hall: 'patterns', room: 'testing', content: 'integration tests validate end-to-end flows', importance: 8 });
    storeDrawer(dir, { wing, hall: 'patterns', room: 'testing', content: 'use createTempStateDir for isolated test databases', importance: 7 });
    storeDrawer(dir, { wing, hall: 'errors', room: 'transient', content: 'this memory expires soon', importance: 3, expiresAt: shortLived });

    // 2. Search finds relevant memories
    const searchResults = searchMemory(dir, { query: 'integration tests', wing });
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults[0]?.snippet).toContain('integration tests');

    // 3. Wake-up surfaces high-importance memories
    const wakeupText = memoryWakeUp(dir, { wing });
    expect(wakeupText).toContain('integration tests validate');

    // High importance (8) appears before lower (3)
    const highIdx = wakeupText.indexOf('integration tests validate');
    const lowIdx = wakeupText.indexOf('this memory expires soon');
    if (lowIdx >= 0) {
      expect(highIdx).toBeLessThan(lowIdx);
    }

    // 4. Prune expired — removes the expired entry
    const prunedCount = pruneExpiredMemories(dir);
    expect(prunedCount).toBe(1);

    // 5. Expired entry no longer searchable
    const afterPrune = searchMemory(dir, { query: 'expires soon' });
    expect(afterPrune.length).toBe(0);

    // 6. Non-expired entries still present
    const surviving = listDrawers(dir, { wing });
    expect(surviving.length).toBe(2);
    expect(surviving.every(d => d.importance >= 7)).toBe(true);
  });
});
