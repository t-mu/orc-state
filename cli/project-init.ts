#!/usr/bin/env node
/** Initialize persistent project state before the container starts its coordinator. */
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { STATE_DIR, assertProjectMode } from '../lib/paths.ts';
import { cliError } from './shared.ts';

try {
  assertProjectMode();
} catch (error) {
  cliError((error as Error).message);
}
ensureStateInitialized(STATE_DIR);
