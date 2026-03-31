#!/usr/bin/env node
/**
 * cli/watch.ts
 * Usage:
 *   node cli/watch.ts [--interval-ms=5000] [--once]
 */
import { render } from 'ink';
import { createElement } from 'react';
import { boolFlag, intFlag } from '../lib/args.ts';
import { renderBanner } from '../lib/banner.ts';
import { colorFormatStatus } from '../lib/colorStatus.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { buildStatus } from '../lib/statusView.ts';
import { partitionValidationErrors, validateStateDir } from '../lib/stateValidation.ts';

export interface WatchOptions {
  intervalMs: number;
  once: boolean;
  stateDir: string;
}

const once = boolFlag('once');
const intervalMs = intFlag('interval-ms', 5000);

export function renderPlainSnapshot({ intervalMs, stateDir }: Pick<WatchOptions, 'intervalMs' | 'stateDir'>): boolean {
  const { fatal, warnings } = partitionValidationErrors(validateStateDir(stateDir));
  if (fatal.length > 0) {
    console.error('State validation failed:');
    for (const error of fatal) console.error(`  - ${error}`);
    return false;
  }

  try {
    const status = buildStatus(stateDir);
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(renderBanner());
    console.log(colorFormatStatus(status));
    if (warnings.length > 0) {
      console.log('');
      console.log('State validation warnings:');
      for (const warning of warnings) console.log(`  - ${warning}`);
    }
  } catch (err) {
    console.error(`buildStatus error (may be transient): ${(err as Error).message}`);
    return false;
  }

  console.log('');
  console.log(`watch interval: ${intervalMs}ms`);
  console.log(`updated at: ${new Date().toISOString()}`);
  return true;
}

export function runFallbackWatch(options: WatchOptions): number | null {
  if (options.once) {
    return renderPlainSnapshot(options) ? 0 : 1;
  }

  if (!renderPlainSnapshot(options)) {
    return 1;
  }

  const timer = setInterval(() => {
    renderPlainSnapshot(options);
  }, options.intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return null;
}

export async function runTtyWatch(options: WatchOptions): Promise<number> {
  const [{ App }, { preloadSprites }] = await Promise.all([
    import('../lib/tui/App.tsx'),
    import('../lib/tui/sprites.ts'),
  ]);

  let sprites;
  try {
    sprites = await preloadSprites();
  } catch (error) {
    console.error(`Failed to preload watch sprites: ${(error as Error).message}`);
    return 1;
  }

  const instance = render(createElement(App, {
    stateDir: options.stateDir,
    sprites,
    intervalMs: options.intervalMs,
  }));

  if (options.once) {
    await waitForFirstFrame();
    instance.unmount();
    await instance.waitUntilExit();
    return 0;
  }

  await instance.waitUntilExit();
  return 0;
}

function waitForFirstFrame(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

export async function main(): Promise<number | null> {
  const options: WatchOptions = {
    once,
    intervalMs,
    stateDir: STATE_DIR,
  };

  if (!process.stdout.isTTY) {
    return runFallbackWatch(options);
  }

  return runTtyWatch(options);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  void main()
    .then(code => {
      if (code !== null) {
        process.exit(code);
      }
    })
    .catch(error => {
      console.error((error as Error).message);
      process.exit(1);
    });
}
