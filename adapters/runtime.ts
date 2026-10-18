/**
 * Structured provider runtime contract (task 203).
 *
 * A runtime is an adapter (AdapterInterface) that additionally speaks a
 * structured local protocol with the provider instead of driving its terminal
 * UI. Runtimes DECLARE what they can do; the core never assumes resume,
 * steering, interrupt or approval support. Asking for an undeclared
 * capability yields a typed CapabilityRefusal rather than a silent fallback.
 *
 * Capabilities are declared only for behaviour proven against the real
 * provider (docs/vnext-provider-protocols.md); protocol methods that exist but
 * have not been exercised end to end stay `false`.
 */

export type RuntimeCapability =
  /** Provider lifecycle is reported as RuntimeEvents rather than terminal text. */
  | 'structured_events'
  /** `submit` resolves only once the provider protocol confirms acceptance. */
  | 'command_ack'
  /** A session can be reattached to its provider thread from a new process. */
  | 'resume'
  /** Input can be added to a turn that is already running. */
  | 'steer'
  /** A running turn can be interrupted. */
  | 'interrupt'
  /** Provider approval requests can be bridged to a human. */
  | 'approvals';

export type RuntimeCapabilities = Readonly<Record<RuntimeCapability, boolean>>;

/** CLI adapters: everything is terminal text; nothing structured is promised. */
export const CLI_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  structured_events: false,
  command_ack: false,
  resume: false,
  steer: false,
  interrupt: false,
  approvals: false,
});

export class CapabilityRefusal extends Error {
  readonly code = 'unsupported_capability';
  readonly capability: RuntimeCapability;
  readonly provider: string;
  constructor(provider: string, capability: RuntimeCapability, detail?: string) {
    super(`${provider} runtime does not support ${capability}${detail ? `: ${detail}` : ''}`);
    this.name = 'CapabilityRefusal';
    this.provider = provider;
    this.capability = capability;
  }
}

/**
 * The structured runtime would bill or authenticate in a way the operator has
 * not demonstrated (e.g. an API key instead of a subscription login). Never
 * downgraded to a warning: the session is not started.
 */
export class UnverifiedAuthError extends Error {
  readonly code = 'unverified_auth';
  readonly provider: string;
  constructor(provider: string, detail: string) {
    super(`${provider} runtime refused to start: ${detail}`);
    this.name = 'UnverifiedAuthError';
    this.provider = provider;
  }
}

/**
 * Provider-neutral event kinds. Message text is not part of the normalized
 * event; adapters keep it in the session output log.
 */
export type RuntimeEventType =
  | 'session_ready'
  | 'session_exited'
  | 'turn_started'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'tool_started'
  | 'tool_completed'
  | 'message_completed'
  | 'approval_requested'
  | 'approval_refused'
  | 'provider_error';

export interface RuntimeEvent {
  type: RuntimeEventType;
  session_handle: string;
  agent_id: string;
  provider: string;
  at: string;
  /** Provider turn id, when the event belongs to a turn. */
  turn_id?: string;
  /** Durable command whose submission started the turn, when known. */
  command_id?: string;
  /** Provider-native name of the frame that produced this event, e.g. `turn/completed`. */
  provider_event: string;
  /** Small, content-free provider metadata (ids, statuses, item kinds). */
  provider_meta: Record<string, unknown>;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface SubmitOptions {
  /** Durable command id; echoed on the resulting turn's events. */
  commandId?: string;
}

/** Proof that the provider accepted a submission. */
export interface SubmitAck {
  turn_id: string;
  /** `started` = a new turn; `steered` = added to the running turn. */
  mode: 'started' | 'steered';
}

export interface StructuredRuntime {
  readonly capabilities: RuntimeCapabilities;
  /** Deliver input and resolve once the provider confirms acceptance. */
  submit(sessionHandle: string, text: string, options?: SubmitOptions): Promise<SubmitAck>;
  onEvent(listener: RuntimeEventListener): () => void;
}

/** Declared capabilities of any adapter; CLI adapters report CLI_CAPABILITIES. */
export function runtimeCapabilities(adapter: unknown): RuntimeCapabilities {
  const declared = (adapter as { capabilities?: unknown } | null)?.capabilities;
  if (!declared || typeof declared !== 'object') return CLI_CAPABILITIES;
  return declared as RuntimeCapabilities;
}

/**
 * Capabilities of one session. A provider adapter can host CLI and structured
 * sessions side by side (routed by handle), so callers ask per session.
 */
export function sessionCapabilities(adapter: unknown, sessionHandle: string): RuntimeCapabilities {
  const forSession = (adapter as { capabilitiesFor?: (handle: string) => RuntimeCapabilities } | null)?.capabilitiesFor;
  if (typeof forSession === 'function') return forSession.call(adapter, sessionHandle);
  return runtimeCapabilities(adapter);
}

/** True when `sessionHandle` is a structured session whose submissions are ACKed by the protocol. */
export function isStructuredSession(adapter: unknown, sessionHandle: string): adapter is StructuredRuntime {
  return sessionCapabilities(adapter, sessionHandle).command_ack
    && typeof (adapter as { submit?: unknown }).submit === 'function'
    && typeof (adapter as { onEvent?: unknown }).onEvent === 'function';
}

/** Throw a typed refusal unless the session declares `capability`. */
export function requireCapability(adapter: unknown, sessionHandle: string, provider: string, capability: RuntimeCapability): void {
  if (!sessionCapabilities(adapter, sessionHandle)[capability]) throw new CapabilityRefusal(provider, capability);
}

/**
 * Environment variables that would route a provider CLI to metered API
 * inference instead of the operator's subscription login. Structured runtimes
 * strip them from the child environment and additionally verify the account
 * type over the protocol before any turn starts.
 */
export const API_BILLING_ENV_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
] as const;

export function withoutApiBillingEnv(env: Record<string, string | undefined>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !(API_BILLING_ENV_KEYS as readonly string[]).includes(key)) next[key] = value;
  }
  return next;
}
