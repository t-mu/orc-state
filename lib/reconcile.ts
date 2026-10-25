import { join } from 'node:path';
import { withLock } from './lock.ts';
import { readJson } from './stateReader.ts';
import { selectDuplicateClaimWinner } from './lifecycleDiagnostics.ts';
import type { Backlog } from '../types/backlog.ts';
import type { ClaimsState, Claim } from '../types/claims.ts';
import type { OrcEventInput } from '../types/events.ts';
import { logger } from './logger.ts';
import { commitClaims, refreshClaimsProjection } from './runStore.ts';
import { commitBacklog, projectTaskStoreFor, type TaskStatusChange } from './projectTasks.ts';

const ACTIVE_CLAIM_STATES = new Set(['claimed', 'in_progress']);

/**
 * Cross-check claims.json against backlog.json and repair inconsistencies
 * from crash-interrupted two-file writes.
 */
export function reconcileState(stateDir: string): void {
  return withLock(join(stateDir, '.lock'), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const backlog = readJson(stateDir, 'backlog.json') as Backlog;
    let claimsModified = false;
    let backlogModified = false;
    const failedClaims: Array<{ claim: Claim; reason: string }> = [];
    const changes: Record<string, TaskStatusChange> = {};
    const projectMode = projectTaskStoreFor(stateDir) !== null;

    const knownTaskRefs = new Set<string>();
    for (const feature of backlog.features ?? []) {
      for (const task of feature.tasks ?? []) {
        if (task.ref) knownTaskRefs.add(task.ref);
      }
    }

    const activeClaimsByTaskRef = new Map<string, Claim[]>();
    const activeClaimByTaskRef = new Map<string, Claim>();
    for (const claim of claims.claims ?? []) {
      if (!ACTIVE_CLAIM_STATES.has(claim.state)) continue;

      if (!knownTaskRefs.has(claim.task_ref)) {
        logger.info(`[reconcile] orphan claim ${claim.run_id} for unknown task_ref ${claim.task_ref} -> failed`);
        claim.state = 'failed';
        failedClaims.push({ claim, reason: 'reconcile_orphan_claim' });
        claimsModified = true;
        continue;
      }

      const current = activeClaimsByTaskRef.get(claim.task_ref) ?? [];
      current.push(claim);
      activeClaimsByTaskRef.set(claim.task_ref, current);
    }

    for (const [taskRef, activeClaims] of activeClaimsByTaskRef) {
      if (activeClaims.length > 1) {
        const keepClaim = selectDuplicateClaimWinner(activeClaims);
        const staleClaims = activeClaims.filter((claim) => claim.run_id !== keepClaim.run_id);
        for (const staleClaim of staleClaims) {
          logger.info(`[reconcile] duplicate active claim ${staleClaim.run_id} for task ${taskRef} -> failed (kept ${keepClaim.run_id})`);
          staleClaim.state = 'failed';
          failedClaims.push({ claim: staleClaim, reason: 'reconcile_duplicate_claim' });
          claimsModified = true;
        }
        activeClaimByTaskRef.set(taskRef, keepClaim);
      } else {
        activeClaimByTaskRef.set(taskRef, activeClaims[0]);
      }
    }

    for (const feature of backlog.features ?? []) {
      for (const task of feature.tasks ?? []) {
        const taskRef = task.ref;
        if (!taskRef) continue;

        const activeClaim = activeClaimByTaskRef.get(taskRef);
        if (activeClaim) {
          const expectedStatus = activeClaim.state === 'in_progress' ? 'in_progress' : 'claimed';
          // A merged task whose run has not finished yet is in the finalize window; finalize retries own it.
          if (projectMode && (task.status === 'done' || task.status === 'released')) continue;
          if (projectMode && task.status !== expectedStatus && !(task.status === 'claimed' && expectedStatus === 'in_progress')) {
            // Project SQLite is authoritative: a claim its task row does not reflect is the orphan.
            logger.info(`[reconcile] claim ${activeClaim.run_id} does not match task ${taskRef} status ${task.status} -> failed`);
            activeClaim.state = 'failed';
            failedClaims.push({ claim: activeClaim, reason: 'reconcile_status_mismatch' });
            claimsModified = true;
            continue;
          }
          if (task.status !== expectedStatus) {
            changes[taskRef] = { cause: 'run_start', runId: activeClaim.run_id, actorId: 'reconcile' };
            logger.info(`[reconcile] repaired task ${taskRef}: status ${task.status} -> ${expectedStatus} (active claim ${activeClaim.run_id} state=${activeClaim.state})`);
            task.status = expectedStatus;
            backlogModified = true;
          }
          continue;
        }

        if (task.status === 'claimed' || task.status === 'in_progress') {
          logger.info(`[reconcile] repaired task ${taskRef}: status ${task.status} -> todo (no active claim found)`);
          task.status = 'todo';
          changes[taskRef] = { cause: 'failure_requeue', actorId: 'reconcile', reason: 'reconcile_missing_claim' };
          backlogModified = true;
        }
      }
    }

    if (backlogModified) {
      commitBacklog(stateDir, backlog, changes);
    }
    if (claimsModified) {
      const now = new Date().toISOString();
      const events: OrcEventInput[] = failedClaims.map(({ claim, reason }) => ({
        ts: now, event: 'run_failed', actor_type: 'coordinator', actor_id: 'reconcile',
        run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id,
        payload: { reason, code: 'ERR_RECONCILE', policy: 'requeue' },
      }));
      commitClaims(stateDir, claims, events);
    }
    refreshClaimsProjection(stateDir);

    const repairCount = (backlogModified ? 1 : 0) + (claimsModified ? 1 : 0);
    if (repairCount === 0) {
      logger.info('[reconcile] state consistent - no repairs needed');
    } else {
      logger.warn(`[reconcile] wrote ${repairCount} repaired file(s)`);
    }
  });
}
