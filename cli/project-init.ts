#!/usr/bin/env node
/** Initialize persistent project state before the container starts its coordinator. */
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { STATE_DIR } from '../lib/paths.ts';

ensureStateInitialized(STATE_DIR);
