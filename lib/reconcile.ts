import { join } from 'node:path';
import { withLock } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { readJson } from './stateReader.ts';
import { selectDuplicateClaimWinner } from './lifecycleDiagnostics.ts';
import type { Backlog } from '../types/backlog.ts';
import type { ClaimsState, Claim } from '../types/claims.ts';

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
        console.log(`[reconcile] orphan claim ${claim.run_id} for unknown task_ref ${claim.task_ref} -> failed`);
        claim.state = 'failed';
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
          console.log(`[reconcile] duplicate active claim ${staleClaim.run_id} for task ${taskRef} -> failed (kept ${keepClaim.run_id})`);
          staleClaim.state = 'failed';
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
          if (task.status !== expectedStatus) {
            console.log(`[reconcile] repaired task ${taskRef}: status ${task.status} -> ${expectedStatus} (active claim ${activeClaim.run_id} state=${activeClaim.state})`);
            task.status = expectedStatus;
            backlogModified = true;
          }
          continue;
        }

        if (task.status === 'claimed' || task.status === 'in_progress') {
          console.log(`[reconcile] repaired task ${taskRef}: status ${task.status} -> todo (no active claim found)`);
          task.status = 'todo';
          backlogModified = true;
        }
      }
    }

    if (backlogModified) {
      atomicWriteJson(join(stateDir, 'backlog.json'), backlog);
    }
    if (claimsModified) {
      atomicWriteJson(join(stateDir, 'claims.json'), claims);
    }

    const repairCount = (backlogModified ? 1 : 0) + (claimsModified ? 1 : 0);
    if (repairCount === 0) {
      console.log('[reconcile] state consistent - no repairs needed');
    } else {
      console.log(`[reconcile] wrote ${repairCount} repaired file(s)`);
    }
  });
}
