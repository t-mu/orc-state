import { createPtyAdapter } from './pty.ts';
import { assertAdapterContract } from './interface.ts';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'gemini']);

/**
 * Create an adapter for the given provider.
 * All providers use the pty adapter; the provider selects which CLI binary to launch.
 *
 * @param provider - 'claude' | 'codex' | 'gemini'
 * @param options
 * @returns adapter object
 */
export function createAdapter(provider: string, options: Record<string, unknown> = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown provider: ${provider}. Supported: ${[...SUPPORTED_PROVIDERS].join(', ')}`,
    );
  }

  const adapter = createPtyAdapter({ ...options, provider });
  assertAdapterContract(adapter);
  return adapter;
}

export { createPtyAdapter, assertAdapterContract };
