/**
 * lib/cockpit2/newAgentDialog.ts — the new-agent dialog: a form
 * (formDialog.ts) choosing what an agent session started from the cockpit
 * runs: a provider and either a fresh session or one of the project's
 * custom agents (`.claude/agents/*.md` in its checkout, read by the CLI
 * layer). The session runs outside the coordinator (explorer.ts, agent tabs).
 *
 * Pure: the form, its Agent row shown only for a custom agent, and what
 * `[ START ]` asks for.
 */
import { formValue, withField, type FormState, type FormStep } from './formDialog.ts';
import { PROVIDERS } from './addProjectDialog.ts';

/** A custom agent definition: its name, description and the prompt sent as the session's first message. */
export interface AgentDefinition { name: string; description: string; prompt: string }

export const FRESH_SESSION = 'fresh session';
export const CUSTOM_AGENT = 'custom agent';
export const NO_CUSTOM_AGENTS = 'no custom agents in .claude/agents';

export interface NewAgentDialogState { form: FormState; definitions: AgentDefinition[] }

/** The dialog for a project's `definitions`, its provider starting on `provider` (claude when not one of the three). */
export function openNewAgentDialog(projectName: string, provider: string | null, definitions: AgentDefinition[]): NewAgentDialogState {
  const form: FormState = {
    title: `spawn grunt · ${projectName}`,
    fields: [
      { kind: 'choice', key: 'provider', label: 'Provider', options: PROVIDERS, value: provider && PROVIDERS.includes(provider) ? provider : 'claude' },
      { kind: 'choice', key: 'variant', label: 'Variant', options: [FRESH_SESSION, CUSTOM_AGENT], value: FRESH_SESSION },
      { kind: 'choice', key: 'agent', label: 'Agent', options: definitions.map((definition) => definition.name), value: definitions[0]?.name ?? '', empty: NO_CUSTOM_AGENTS, hidden: true },
    ],
    buttons: [{ id: 'start', label: '[ START ]', role: 'button' }, { id: 'cancel', label: '[ CANCEL ]', role: 'text.muted' }],
    cursor: 0,
    error: null,
    busy: null,
  };
  return { form, definitions };
}

/** The form after a step: the Agent row shown only while the variant is a custom agent. */
export function newAgentStep(state: NewAgentDialogState, step: FormStep): { state: NewAgentDialogState; action: string | null } {
  const custom = formValue(step.state, 'variant') === CUSTOM_AGENT;
  const form = withField(step.state, 'agent', (field) => ({ ...field, hidden: !custom }));
  return { state: { ...state, form }, action: step.action };
}

/** What START opens: the provider and the custom agent (null for a fresh session); or why it is refused. */
export function newAgentRequest(state: NewAgentDialogState): { provider: string; agent: AgentDefinition | null } | { error: string } {
  const provider = formValue(state.form, 'provider');
  if (formValue(state.form, 'variant') !== CUSTOM_AGENT) return { provider, agent: null };
  const name = formValue(state.form, 'agent');
  const agent = state.definitions.find((definition) => definition.name === name);
  if (!agent) return { error: state.definitions.length ? `Choose an agent.` : 'No custom agents in .claude/agents to start.' };
  return { provider, agent };
}

/** Each provider's flag that skips its permission prompts (YOLO), as orc's full-access workers launch it. */
const FULL_ACCESS_FLAGS: Readonly<Record<string, string>> = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
};

/** What an agent session's command takes from the project's settings. */
export interface AgentLaunchOptions {
  /** The project's worker execution mode: `full-access` (default) skips the provider's permission prompts, `sandbox` keeps them. */
  executionMode?: string | null;
  /** The project's default model for the provider; none leaves the CLI's own default. */
  model?: string | null;
}

/** A model name safe to put on the command line unquoted (model ids are like `sonnet`, `gpt-6-sol`, `gemini-3.5-flash`). */
const SAFE_MODEL = /^[A-Za-z0-9._:/-]+$/;

/**
 * The command an agent session runs: the provider's CLI, interactive, with
 * none of orc's hooks or settings; under the project's `full-access`
 * execution mode (the default) it skips its permission prompts as full-access
 * workers do, and it runs the project's default model for the provider.
 */
export function agentCommand(provider: string, options: AgentLaunchOptions = {}): string {
  const cli = PROVIDERS.includes(provider) ? provider : 'claude';
  const args = [cli];
  if ((options.executionMode ?? 'full-access') !== 'sandbox') args.push(FULL_ACCESS_FLAGS[cli]);
  if (options.model && SAFE_MODEL.test(options.model)) args.push('--model', options.model);
  return args.join(' ');
}

/** The launch options for `provider` from a project's effective settings (dotted keys). */
export function agentLaunchOptions(settings: Record<string, unknown>, provider: string): AgentLaunchOptions {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    executionMode: text(settings['worker_pool.execution_mode']) ?? text(settings.default_execution_mode),
    model: text(settings[`worker_pool.provider_models.${provider}`]) ?? text(settings['worker_pool.model']),
  };
}
