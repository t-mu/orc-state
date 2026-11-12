/**
 * lib/cockpit2/settingsDialog.ts — the project settings dialog: a modal form
 * over the cockpit for the few settings worth changing while orc runs.
 *
 * Pure: the form's state, what a key or click does to it, and how it is
 * drawn. The app (app.ts) opens it with the project's effective settings,
 * routes every key and click to it while it is open, and on save writes the
 * changed settings through its `SettingsHost` (the CLI layer, as `orc project
 * config set` does) and, when asked, restarts the coordinator.
 *
 * The coordinator reads the worker pool settings on every tick, so max
 * workers and the default worker provider and model apply at once; merge
 * strategy, PR provider and execution mode are read when it starts, so a
 * change to them offers "save & restart".
 */
import { stringWidth } from '../cellWidth.ts';
import { drawBox } from './chrome.ts';
import { drawText, fillRect, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { styleOf, type Theme } from './theme.ts';

/** A setting value as the registry stores it; null is unset. */
export type SettingValue = string | number | null;

/** What the dialog needs from the CLI layer. */
export interface SettingsHost {
  /** The project's effective settings, dotted keys (`orc project config list`). */
  read(projectId: string): Record<string, unknown>;
  /** Stores one project setting (`orc project config set --project`); throws when invalid. */
  write(projectId: string, key: string, value: SettingValue): void;
  /** Restarts the project's coordinator (`orc coordinator restart`). */
  restartCoordinator(projectId: string): Promise<void>;
}

export interface SettingsField {
  key: string;
  label: string;
  /** The values ←/→ cycle through. */
  options: SettingValue[];
  value: SettingValue;
  original: SettingValue;
  /** The coordinator reads it only when it starts. */
  restart: boolean;
}

export type DialogButton = 'save' | 'saveRestart' | 'cancel';

export interface SettingsDialogState {
  projectId: string;
  projectName: string;
  fields: SettingsField[];
  /** Index into `rows(state)`: a field or a button. */
  cursor: number;
  error: string | null;
  /** Saving or restarting: keys are ignored until it ends. */
  busy: string | null;
  /** The stored default model of each provider, so changing the provider shows its model. */
  models: Record<string, SettingValue>;
}

const PROVIDERS = ['claude', 'codex', 'gemini'];
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];
const MAX_WORKERS_LIMIT = 8;

const asValue = (value: unknown): SettingValue => (typeof value === 'string' || typeof value === 'number' ? value : null);
/** `options` with `value` in it (a stored value outside the usual choices stays selectable). */
const withValue = (options: SettingValue[], value: SettingValue): SettingValue[] => (options.includes(value) ? options : [value, ...options]);

/** The model key the default worker model lives under for `provider`: its per-provider model wins over `worker_pool.model`. */
export const modelKey = (provider: SettingValue) => `worker_pool.provider_models.${String(provider ?? 'claude')}`;

function modelField(settings: Record<string, unknown>, provider: SettingValue): SettingsField {
  const key = modelKey(provider);
  const value = asValue(settings[key] ?? settings['worker_pool.model']);
  const options = withValue(provider === 'claude' ? CLAUDE_MODELS : [], value);
  return { key, label: 'Default worker model', options, value, original: value, restart: false };
}

/** The dialog for `projectId` from its effective settings. */
export function openSettingsDialog(projectId: string, projectName: string, settings: Record<string, unknown>): SettingsDialogState {
  const field = (key: string, label: string, options: SettingValue[], restart: boolean, fallback: SettingValue = null): SettingsField => {
    const value = asValue(settings[key]) ?? fallback;
    return { key, label, options: withValue(options, value), value, original: value, restart };
  };
  // Unset, the worker pool falls back to the project-wide defaults, then to orc's (lib/providers.ts).
  const defaultProvider = asValue(settings.default_provider) ?? 'codex';
  const defaultMode = asValue(settings.default_execution_mode) ?? 'full-access';
  const provider = asValue(settings['worker_pool.provider']) ?? defaultProvider;
  return {
    projectId, projectName, cursor: 0, error: null, busy: null,
    models: Object.fromEntries(PROVIDERS.map((name) => [name, asValue(settings[modelKey(name)] ?? settings['worker_pool.model'])])),
    fields: [
      field('worker_pool.max_workers', 'Max workers', Array.from({ length: MAX_WORKERS_LIMIT + 1 }, (_, n) => n), false, 0),
      field('coordinator.merge_strategy', 'Merge', ['direct', 'pr'], true, 'direct'),
      field('coordinator.pr_provider', 'PR provider', [null, 'github'], true),
      field('worker_pool.provider', 'Default worker provider', PROVIDERS, false, defaultProvider),
      modelField(settings, provider),
      field('worker_pool.execution_mode', 'Execution mode', ['full-access', 'sandbox'], true, defaultMode),
    ],
  };
}

const fieldOf = (state: SettingsDialogState, key: string) => state.fields.find((field) => field.key === key);

/** The fields shown: the PR provider only while merge is `pr`. */
export function visibleFields(state: SettingsDialogState): SettingsField[] {
  const merge = fieldOf(state, 'coordinator.merge_strategy')?.value;
  return state.fields.filter((field) => field.key !== 'coordinator.pr_provider' || merge === 'pr');
}

/** The settings changed from what was read. */
export function changes(state: SettingsDialogState): Array<{ key: string; value: SettingValue }> {
  return visibleFields(state).filter((field) => field.value !== field.original).map(({ key, value }) => ({ key, value }));
}

/** A changed setting is read only when the coordinator starts. */
export const needsRestart = (state: SettingsDialogState) => visibleFields(state).some((field) => field.restart && field.value !== field.original);

/** The buttons shown: save & restart only when a change needs it. */
export function buttons(state: SettingsDialogState): DialogButton[] {
  return needsRestart(state) ? ['save', 'saveRestart', 'cancel'] : ['save', 'cancel'];
}

type Row = { kind: 'field'; field: SettingsField } | { kind: 'button'; button: DialogButton };
export function rows(state: SettingsDialogState): Row[] {
  return [...visibleFields(state).map((field): Row => ({ kind: 'field', field })), ...buttons(state).map((button): Row => ({ kind: 'button', button }))];
}

/** Why the form cannot be saved, or null. */
export function validate(state: SettingsDialogState): string | null {
  if (fieldOf(state, 'coordinator.merge_strategy')?.value === 'pr' && !fieldOf(state, 'coordinator.pr_provider')?.value) {
    return 'PR merge needs a PR provider.';
  }
  return null;
}

export type DialogKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'next' | 'previous';
export type DialogAction = 'cancel' | 'save' | 'saveRestart' | null;
export interface DialogStep { state: SettingsDialogState; action: DialogAction }

const clampCursor = (state: SettingsDialogState): SettingsDialogState => ({ ...state, cursor: Math.max(0, Math.min(state.cursor, rows(state).length - 1)) });

/** Changes the field under the cursor by `delta` steps through its options; a provider change brings its model along. */
function cycle(state: SettingsDialogState, field: SettingsField, delta: 1 | -1): SettingsDialogState {
  if (field.options.length < 2) return state;
  const index = Math.max(0, field.options.indexOf(field.value));
  const value = field.options[(index + delta + field.options.length) % field.options.length];
  let fields = state.fields.map((candidate) => (candidate === field ? { ...candidate, value } : candidate));
  if (field.key === 'worker_pool.provider') {
    fields = fields.map((candidate) => (candidate.key.startsWith('worker_pool.provider_models.') ? modelFieldFor(state, value) : candidate));
  }
  return clampCursor({ ...state, fields, error: null });
}

/** The model field after the provider changed: that provider's stored model (unchanged, so nothing is written for it). */
function modelFieldFor(state: SettingsDialogState, provider: SettingValue): SettingsField {
  const value = state.models[String(provider)] ?? null;
  return { key: modelKey(provider), label: 'Default worker model', options: withValue(provider === 'claude' ? CLAUDE_MODELS : [], value), value, original: value, restart: false };
}

/** What a key does: move between rows, change a field, press a button, or close. */
export function dialogKey(state: SettingsDialogState, key: DialogKey): DialogStep {
  if (state.busy) return { state, action: null };
  const all = rows(state);
  const row = all[state.cursor];
  switch (key) {
    case 'escape': return { state, action: 'cancel' };
    case 'up': case 'previous': return { state: { ...state, cursor: (state.cursor - 1 + all.length) % all.length }, action: null };
    case 'down': case 'next': return { state: { ...state, cursor: (state.cursor + 1) % all.length }, action: null };
    case 'left': case 'right': {
      if (row?.kind === 'field') return { state: cycle(state, row.field, key === 'left' ? -1 : 1), action: null };
      // Between buttons ←/→ move like ↑/↓.
      return dialogKey(state, key === 'left' ? 'up' : 'down');
    }
    case 'enter': {
      if (row?.kind === 'button') return press(state, row.button);
      // Enter on a field saves the form, the usual dialog default.
      return press(state, 'save');
    }
  }
}

function press(state: SettingsDialogState, button: DialogButton): DialogStep {
  if (button === 'cancel') return { state, action: 'cancel' };
  const error = validate(state);
  if (error) return { state: { ...state, error }, action: null };
  return { state, action: button };
}

// ── drawing ───────────────────────────────────────────────────────────────────

const DIALOG_COLS = 52;
const LABEL_COLS = 26;
const BUTTON_LABEL: Record<DialogButton, string> = { save: '[ SAVE ]', saveRestart: '[ SAVE & RESTART ]', cancel: '[ CANCEL ]' };
const shown = (value: SettingValue) => (value === null ? 'none' : String(value));

/** Where the dialog sits in a `cols` by `rows` frame, and where its rows and buttons are. */
export interface DialogLayout {
  box: Region;
  /** The y of each field row, in `visibleFields` order. */
  fieldY: number[];
  buttonsY: number;
  /** Each button's x range on `buttonsY`. */
  buttonX: Array<{ button: DialogButton; x: number; cols: number }>;
}

export function dialogLayout(state: SettingsDialogState, cols: number, rowsAvailable: number): DialogLayout {
  const fields = visibleFields(state);
  const height = Math.min(rowsAvailable, fields.length + 8);
  const width = Math.min(cols, DIALOG_COLS);
  const box = { x: Math.max(0, Math.floor((cols - width) / 2)), y: Math.max(0, Math.floor((rowsAvailable - height) / 2)), cols: width, rows: height };
  const fieldY = fields.map((_, index) => box.y + 2 + index);
  const buttonsY = box.y + box.rows - 2;
  let x = box.x + 3;
  const buttonX = buttons(state).map((button) => {
    const at = { button, x, cols: stringWidth(BUTTON_LABEL[button]) };
    x += at.cols + 2;
    return at;
  });
  return { box, fieldY, buttonsY, buttonX };
}

/** What a click at (x, y) does: focus and change a field (a click on its value cycles it), or press a button. */
export function dialogClick(state: SettingsDialogState, layout: DialogLayout, x: number, y: number): DialogStep {
  if (state.busy) return { state, action: null };
  const fieldIndex = layout.fieldY.indexOf(y);
  if (fieldIndex >= 0) {
    const field = visibleFields(state)[fieldIndex];
    const focused = { ...state, cursor: fieldIndex };
    return x >= layout.box.x + 2 + LABEL_COLS ? { state: cycle(focused, field, 1), action: null } : { state: focused, action: null };
  }
  if (y === layout.buttonsY) {
    const hit = layout.buttonX.find((button) => x >= button.x && x < button.x + button.cols);
    if (hit) return press({ ...state, cursor: rows(state).findIndex((row) => row.kind === 'button' && row.button === hit.button) }, hit.button);
  }
  return { state, action: null };
}

/**
 * Draws the dialog over `frame` (the app dims what is behind it first): a box
 * in the panel colour with the fields, the restart note, an error, and the
 * buttons; the cursor's row in `row.cursor`, changed values in `text.accent`.
 */
export function drawSettingsDialog(frame: Frame, layout: DialogLayout, state: SettingsDialogState, theme: Theme, panel: CellStyle['bg']): void {
  const { box } = layout;
  fillRect(frame, box, { ...styleOf(theme, 'text.primary'), bg: panel });
  drawBox(frame, box, { title: `settings · ${state.projectName}`, focused: true, theme });
  const inner = box.cols - 4;
  const onPanel = (style: CellStyle): CellStyle => (style.bg.type === 'default' ? { ...style, bg: panel } : style);
  const all = rows(state);
  visibleFields(state).forEach((field, index) => {
    const y = layout.fieldY[index];
    const cursor = all[state.cursor]?.kind === 'field' && state.cursor === index;
    const label = onPanel(styleOf(theme, cursor ? 'row.cursor' : 'text.muted'));
    const value = onPanel(styleOf(theme, field.value !== field.original ? 'text.accent' : 'text.primary'));
    if (cursor) fillRect(frame, { x: box.x + 1, y, cols: box.cols - 2, rows: 1 }, label);
    drawText(frame, box.x + 2, y, field.label, label, LABEL_COLS - 1);
    const choice = field.options.length > 1 ? `‹ ${shown(field.value)} ›` : shown(field.value);
    drawText(frame, box.x + 2 + LABEL_COLS, y, choice, cursor ? { ...value, bg: label.bg, bold: true } : value, inner - LABEL_COLS);
  });
  const noteY = layout.fieldY.length ? layout.fieldY[layout.fieldY.length - 1] + 2 : box.y + 2;
  const note = state.busy ?? state.error ?? (needsRestart(state) ? '! Applies after a coordinator restart.' : changes(state).length ? 'Applies at once.' : '');
  if (note && noteY < layout.buttonsY) {
    drawText(frame, box.x + 2, noteY, note, onPanel(styleOf(theme, state.error ? 'error' : needsRestart(state) ? 'status.warn' : 'text.muted')), inner);
  }
  for (const { button, x } of layout.buttonX) {
    const cursor = all[state.cursor]?.kind === 'button' && all[state.cursor].kind === 'button' && (all[state.cursor] as { button: DialogButton }).button === button;
    const style = cursor ? styleOf(theme, 'tab.active') : onPanel(styleOf(theme, button === 'cancel' ? 'text.muted' : 'button'));
    drawText(frame, x, layout.buttonsY, BUTTON_LABEL[button], style, box.x + box.cols - 1 - x);
  }
}

/** Dims every cell of `frame`: what is behind a dialog. */
export function dimFrame(frame: Frame): void {
  for (const cell of frame.cells) cell.style = { ...cell.style, dim: true };
}
