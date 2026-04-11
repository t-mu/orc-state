import { GitHubAdapter } from './github.ts';
import type { GitHostAdapter } from './interface.ts';

export function getGitHostAdapter(provider: string): GitHostAdapter {
  if (provider === 'github') return new GitHubAdapter();
  throw new Error(`Unsupported git host provider: ${provider}. Supported: github`);
}

export type { GitHostAdapter } from './interface.ts';
