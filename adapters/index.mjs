import { createPtyAdapter } from './pty.mjs';
import { assertAdapterContract } from './interface.mjs';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'gemini']);

/**
 * Create an adapter for the given provider.
 * All providers use the pty adapter; the provider selects which CLI binary to launch.
 *
 * @param {'claude'|'codex'|'gemini'} provider
 * @param {object} [options]
 * @returns {object}
 */
export function createAdapter(provider, options = {}) {
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
