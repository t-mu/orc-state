/**
 * What a provider session can do, per provider and transport: the one table
 * orc's resume, launch and terminal code read, and session listings expose as
 * `capabilities` so a UI does not copy the rules. See docs/adapters.md →
 * Session capabilities.
 */

export type SessionTransport = 'tmux' | 'app-server';

/**
 * Which session-start hook marks the session ready: `always`, only in the
 * `full-access` execution mode (a sandboxed session reports for duty), or
 * `never` (report-for-duty, or the protocol handshake of an `app:` session).
 */
export type ReadinessHook = 'always' | 'full-access' | 'never';

export interface SessionCapabilities {
  /** A crashed session is relaunched in place under the same conversation. */
  resume: boolean;
  /** Who names the provider conversation: orc at launch, the provider (recorded once known), or nobody. */
  conversation_id: 'orc' | 'provider' | null;
  /** The session has a provider terminal to stream (`/v1/terminals`, `orc terminal`). */
  attach: boolean;
  /** Keystrokes can be written to that terminal. */
  terminal_input: boolean;
  readiness_hook: ReadinessHook;
  /** `orc start-session` can run the master on it. */
  can_be_master: boolean;
}

const NONE: Readonly<SessionCapabilities> = Object.freeze({
  resume: false, conversation_id: null, attach: false, terminal_input: false, readiness_hook: 'never', can_be_master: false,
});

const TERMINAL = { attach: true, terminal_input: true, can_be_master: true } as const;

export const SESSION_CAPABILITIES: Readonly<Record<string, Partial<Record<SessionTransport, Readonly<SessionCapabilities>>>>> = Object.freeze({
  claude: {
    // orc picks `--session-id` and relaunches with `--resume`.
    tmux: Object.freeze({ ...TERMINAL, resume: true, conversation_id: 'orc', readiness_hook: 'always' }),
  },
  codex: {
    // The hook records the conversation id, but the Codex terminal CLI is not resumed.
    tmux: Object.freeze({ ...TERMINAL, resume: false, conversation_id: 'provider', readiness_hook: 'full-access' }),
    // `thread/resume`; ready from the protocol handshake; no terminal.
    'app-server': Object.freeze({ ...NONE, resume: true, conversation_id: 'provider' }),
  },
  gemini: {
    tmux: Object.freeze({ ...TERMINAL, resume: false, conversation_id: null, readiness_hook: 'never' }),
  },
});

/** The capabilities of a provider session on a transport; an unknown pair (a legacy `pty` session) can do nothing. */
export function sessionCapabilities(provider: string | null | undefined, transport: string | null | undefined): SessionCapabilities {
  if (!provider || !transport) return { ...NONE };
  const entry = SESSION_CAPABILITIES[provider]?.[transport as SessionTransport];
  return { ...(entry ?? NONE) };
}

/** The transport a session handle names (`tmux:<agent>`, `app:<agent>`), or null. */
export function transportOfHandle(handle: string | null | undefined): SessionTransport | null {
  if (handle?.startsWith('tmux:')) return 'tmux';
  if (handle?.startsWith('app:')) return 'app-server';
  return null;
}
