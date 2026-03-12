/**
 * @t-mu/orc-state — public API
 *
 * Stable exports (semver-guarded):
 *   createAdapter, assertAdapterContract  — provider adapter factory + contract check
 *   validateBacklog/Agents/Claims/StateDir — JSON state validators
 *   validateEventObject                   — event schema validator
 *
 * The ./coordinator and ./adapters subpath exports are stable entry points for
 * CLI use; their internal structure is not part of the public contract.
 */
export { createAdapter, assertAdapterContract } from './adapters/index.mjs';

export {
  validateBacklog,
  validateAgents,
  validateClaims,
  validateStateDir,
} from './lib/stateValidation.mjs';

export { validateEventObject } from './lib/eventValidation.mjs';
