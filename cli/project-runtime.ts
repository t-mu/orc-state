#!/usr/bin/env node
/** Container PID 1 path: initialize persistent state once, then run the coordinator. */
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { main } from '../coordinator.ts';

ensureStateInitialized(STATE_DIR);
await main();
