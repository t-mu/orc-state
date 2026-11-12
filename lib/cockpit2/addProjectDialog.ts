/**
 * lib/cockpit2/addProjectDialog.ts — the add-project dialog: a form
 * (formDialog.ts) for registering a git checkout on this machine as an orc
 * project and choosing its provider.
 *
 * Pure: the form and what `[ ADD ]` asks for. The app (app.ts) opens it,
 * and on ADD calls its `ProjectHost` (the CLI layer: `orc project add`, then
 * `orc init --provider`), showing a failure in the dialog or closing it.
 */
import { textField } from './textField.ts';
import { formValue, type FormState } from './formDialog.ts';

/** What the add-project dialog needs from the CLI layer. */
export interface ProjectHost {
  /** Registers the git checkout at `path` (optionally named) and configures it for `provider`; rejects with why it failed. */
  add(path: string, name: string | null, provider: string): Promise<{ projectId: string }>;
}

export const PROVIDERS = ['claude', 'codex', 'gemini'];

export function openAddProjectDialog(): FormState {
  return {
    title: 'new campaign',
    fields: [
      { kind: 'text', key: 'path', label: 'Path', text: textField(), placeholder: '/absolute/path/to/checkout' },
      { kind: 'text', key: 'name', label: 'Name', text: textField(), placeholder: 'optional: the folder name' },
      { kind: 'choice', key: 'provider', label: 'Provider', options: PROVIDERS, value: 'claude' },
    ],
    buttons: [{ id: 'add', label: '[ ADD ]', role: 'button' }, { id: 'cancel', label: '[ CANCEL ]', role: 'text.muted' }],
    cursor: 0,
    error: null,
    busy: null,
  };
}

/** What ADD registers: the path, the name (null when blank) and the provider; or why the form is refused. */
export function addProjectRequest(state: FormState): { path: string; name: string | null; provider: string } | { error: string } {
  const path = formValue(state, 'path').trim();
  if (!path) return { error: 'Path is required: the git checkout to add.' };
  if (!path.startsWith('/')) return { error: 'Path must be absolute (start with /).' };
  const name = formValue(state, 'name').trim();
  return { path, name: name || null, provider: formValue(state, 'provider') };
}
