/**
 * lib/cockpit2/theme.ts — the cockpit's style roles, the built-in themes and
 * how a theme is resolved from overrides and from env plus a theme file.
 *
 * A widget asks for a role (`styleOf(theme, 'status.warn')`), never for a
 * colour. Which status role a project state, attention kind or run phase gets
 * is decided here and nowhere else (`projectStateRole`, `attentionRole`,
 * `phaseRole`).
 *
 * Pure: env and the file reader are parameters (as `resolveCockpitKeys` in
 * lib/cockpitKeys.ts); colour depth is render.ts's concern.
 */
import type { AttentionKind, SidebarProjectState } from '../tui/sidebar.ts';
import type { CellStyle, Color } from './screen.ts';

// ── roles ─────────────────────────────────────────────────────────────────────

export const STATUS_ROLES = ['status.active', 'status.attention', 'status.warn', 'status.error', 'status.idle'] as const;
export type StatusRole = typeof STATUS_ROLES[number];
export type BadgeRole = `${StatusRole}.badge`;

/** Every role, in a fixed order: a theme defines each one. */
export const THEME_ROLES: readonly ThemeRole[] = [
  'chrome.border', 'chrome.borderFocus', 'chrome.title', 'chrome.titleFocus', 'chrome.meta',
  'text.primary', 'text.muted', 'text.accent', 'text.edge',
  'row.cursor', 'button', 'button.attention', 'tab.close', 'error',
  ...STATUS_ROLES.flatMap((role): ThemeRole[] => [role, `${role}.badge`]),
];
export type ThemeRole = 'chrome.border' | 'chrome.borderFocus' | 'chrome.title' | 'chrome.titleFocus' | 'chrome.meta'
  | 'text.primary' | 'text.muted' | 'text.accent' | 'text.edge'
  | 'row.cursor' | 'button' | 'button.attention' | 'tab.close' | 'error'
  | StatusRole | BadgeRole;

/** A role's style; unset attributes are off and unset colours `default`. */
export interface RoleStyle {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
}

const ATTRIBUTES = ['bold', 'dim', 'inverse', 'underline'] as const;

export interface Theme {
  /** The built-in theme it is, or is based on. */
  name: BuiltInThemeName;
  roles: Readonly<Record<ThemeRole, RoleStyle>>;
}

// ── state → role (the only place) ─────────────────────────────────────────────

const PROJECT_STATE_ROLE: Readonly<Record<SidebarProjectState, StatusRole>> = {
  running: 'status.active', connecting: 'status.idle', stopped: 'status.warn', stale: 'status.error', incompatible: 'status.error',
};
const ATTENTION_ROLE: Readonly<Record<AttentionKind, StatusRole>> = {
  permission_prompt: 'status.attention', question: 'status.attention', stalled: 'status.error', no_progress: 'status.warn',
};
const ACTIVE_PHASES = new Set(['explore', 'implement', 'complete', 'finalize']);

export const projectStateRole = (state: SidebarProjectState): StatusRole => PROJECT_STATE_ROLE[state];
export const attentionRole = (kind: AttentionKind): StatusRole => ATTENTION_ROLE[kind];
/** A run phase's role: working phases active, review warn, anything else (none, unknown) idle. */
export function phaseRole(phase: string | null | undefined): StatusRole {
  if (phase && ACTIVE_PHASES.has(phase)) return 'status.active';
  return phase === 'review' ? 'status.warn' : 'status.idle';
}
export const badgeRole = (role: StatusRole): BadgeRole => `${role}.badge`;

// ── colours ───────────────────────────────────────────────────────────────────

/** A theme colour (`"default"`, a palette index 0-255 or `"#rrggbb"`) as the screen model's `Color`; null if invalid. */
export function parseThemeColor(value: unknown): Color | null {
  if (value === 'default') return { type: 'default' };
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 255 ? { type: 'palette', index: value } : null;
  if (typeof value !== 'string') return null;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return hex ? { type: 'rgb', r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16) } : null;
}

const rgb = (hex: string): Color => parseThemeColor(hex)!;
const palette = (index: number): Color => ({ type: 'palette', index });

// ── built-in themes ───────────────────────────────────────────────────────────

const AMBER = rgb('#ffb000');
const AMBER_FOCUS = rgb('#ffc233');
const TEXT = rgb('#e6edf3');
const MUTED = rgb('#8b949e');
const EDGE = rgb('#484f58');
const STATUS_FG: Record<StatusRole, Color> = {
  'status.active': rgb('#00ff66'), 'status.attention': rgb('#d946ef'), 'status.warn': rgb('#f59e0b'),
  'status.error': rgb('#ef4444'), 'status.idle': rgb('#64748b'),
};
const STATUS_BG: Record<StatusRole, Color> = {
  'status.active': rgb('#003314'), 'status.attention': rgb('#2e0836'), 'status.warn': rgb('#2e1a00'),
  'status.error': rgb('#330a0a'), 'status.idle': rgb('#181c22'),
};

const statusRoles = (fg: (role: StatusRole) => RoleStyle, badge: (role: StatusRole) => RoleStyle) =>
  Object.fromEntries(STATUS_ROLES.flatMap((role) => [[role, fg(role)], [badgeRole(role), badge(role)]])) as Record<StatusRole | BadgeRole, RoleStyle>;

/** The default: amber chrome on the terminal's own background; backgrounds only for badges, the cursor row and attention. */
const amber: Theme = {
  name: 'amber',
  roles: {
    'chrome.border': { fg: AMBER },
    'chrome.borderFocus': { fg: AMBER_FOCUS, bold: true },
    'chrome.title': { fg: AMBER, bold: true },
    'chrome.titleFocus': { fg: AMBER_FOCUS, bold: true, inverse: true },
    'chrome.meta': { fg: MUTED },
    'text.primary': { fg: TEXT },
    'text.muted': { fg: MUTED },
    'text.accent': { fg: AMBER, bold: true },
    'text.edge': { fg: EDGE },
    'row.cursor': { fg: TEXT, bg: STATUS_BG['status.idle'], bold: true },
    'button': { fg: AMBER, underline: true },
    'button.attention': { fg: STATUS_FG['status.attention'], bg: STATUS_BG['status.attention'], bold: true },
    'tab.close': { fg: STATUS_FG['status.error'] },
    'error': { fg: STATUS_FG['status.error'], bold: true },
    ...statusRoles((role) => ({ fg: STATUS_FG[role] }), (role) => ({ fg: STATUS_FG[role], bg: STATUS_BG[role], bold: true })),
  },
};

/** Today's project state colours (widgets.ts STATE_COLOR): running green, connecting cyan, stopped yellow, stale red. */
const CLASSIC_STATUS: Record<StatusRole, Color> = {
  'status.active': palette(2), 'status.attention': palette(3), 'status.warn': palette(3), 'status.error': palette(1), 'status.idle': palette(6),
};

/**
 * Today's cockpit styles (lib/cockpit2/widgets.ts, app.ts and frame.ts's
 * EDGE_STYLE): a status role is today's state colour as fg (project state,
 * agent detail), its badge today's agent tag (bold, inverse, the colour).
 * Where several of today's styles share one role, the frame differs:
 * - attention kinds had one colour each (permission red, question yellow,
 *   stalled magenta, no_progress cyan); `status.attention` takes the
 *   attention button's yellow, stalled and no_progress their status role's;
 * - the tab badge and the sidebar's attention count were bold without
 *   inverse; as badges they become bold inverse;
 * - the sidebar notice (yellow, no attribute) maps to `status.warn`.
 */
const classic: Theme = {
  name: 'classic',
  roles: {
    'chrome.border': { dim: true },
    'chrome.borderFocus': { fg: palette(6), bold: true },
    'chrome.title': { bold: true },
    'chrome.titleFocus': { fg: palette(6), bold: true, inverse: true },
    'chrome.meta': { dim: true },
    'text.primary': {},
    'text.muted': { dim: true },
    'text.accent': { bold: true },
    'text.edge': { dim: true },
    'row.cursor': { inverse: true },
    'button': { fg: palette(6), underline: true },
    'button.attention': { fg: palette(3), bold: true, inverse: true },
    'tab.close': { fg: palette(1) },
    'error': { fg: palette(1), bold: true },
    ...statusRoles(
      (role) => ({ fg: CLASSIC_STATUS[role] }),
      (role) => ({ fg: CLASSIC_STATUS[role], bold: true, inverse: true }),
    ),
  },
};

/**
 * No colour at all: states differ by attributes, and their text labels carry
 * the meaning. A status role uses bold, underline and dim, never inverse, so it
 * stays apart from the cursor row; its badge is the same plus inverse.
 */
const mono: Theme = {
  name: 'mono',
  roles: {
    'chrome.border': { dim: true },
    'chrome.borderFocus': { bold: true },
    'chrome.title': { bold: true },
    'chrome.titleFocus': { bold: true, inverse: true },
    'chrome.meta': { dim: true },
    'text.primary': {},
    'text.muted': { dim: true },
    'text.accent': { bold: true },
    'text.edge': { dim: true },
    'row.cursor': { inverse: true },
    'button': { underline: true },
    'button.attention': { bold: true, inverse: true },
    'tab.close': { bold: true },
    'error': { bold: true, underline: true },
    'status.active': { bold: true },
    'status.active.badge': { bold: true, inverse: true },
    'status.attention': { bold: true, underline: true },
    'status.attention.badge': { bold: true, underline: true, inverse: true },
    'status.warn': { underline: true, dim: true },
    'status.warn.badge': { underline: true, dim: true, inverse: true },
    'status.error': { underline: true },
    'status.error.badge': { underline: true, inverse: true },
    'status.idle': { dim: true },
    'status.idle.badge': { dim: true, inverse: true },
  },
};

export const BUILT_IN_THEMES = { amber, classic, mono } as const;
export type BuiltInThemeName = 'amber' | 'classic' | 'mono';
export const DEFAULT_THEME = amber;

const isBuiltInName = (name: unknown): name is BuiltInThemeName => typeof name === 'string' && Object.hasOwn(BUILT_IN_THEMES, name);

// ── resolution ────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isRole = (name: string): name is ThemeRole => (THEME_ROLES as readonly string[]).includes(name);

/** A role override checked field by field: the parsed style, or the problems it has. */
function parseRoleStyle(role: string, raw: unknown): { style: RoleStyle; problems: string[] } {
  if (!isRecord(raw)) return { style: {}, problems: [`role '${role}': expected an object of fg, bg, bold, dim, inverse, underline`] };
  const style: RoleStyle = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'fg' || key === 'bg') {
      const color = parseThemeColor(value);
      if (color) style[key] = color;
      else problems.push(`role '${role}': ${key} ${JSON.stringify(value)} is not "default", a palette index 0-255 or "#rrggbb"`);
    } else if ((ATTRIBUTES as readonly string[]).includes(key)) {
      if (typeof value === 'boolean') style[key as typeof ATTRIBUTES[number]] = value;
      else problems.push(`role '${role}': ${key} must be true or false, not ${JSON.stringify(value)}`);
    } else {
      problems.push(`role '${role}': unknown field '${key}' (fields: fg, bg, ${ATTRIBUTES.join(', ')})`);
    }
  }
  return { style, problems };
}

/**
 * `base` with `overrides` (role name → partial role style) merged per role.
 * An unknown role, a bad colour, a non-boolean attribute or an unknown field
 * is reported in `problems`, and that role keeps its base style.
 */
export function resolveTheme(base: Theme, overrides: unknown): { theme: Theme; problems: string[] } {
  if (overrides === undefined) return { theme: base, problems: [] };
  if (!isRecord(overrides)) return { theme: base, problems: ['roles: expected an object of role name to style'] };
  const roles: Record<ThemeRole, RoleStyle> = { ...base.roles };
  const problems: string[] = [];
  for (const [role, raw] of Object.entries(overrides)) {
    if (!isRole(role)) {
      problems.push(`unknown role '${role}' (roles: ${THEME_ROLES.join(', ')})`);
      continue;
    }
    const parsed = parseRoleStyle(role, raw);
    if (parsed.problems.length > 0) problems.push(...parsed.problems);
    else roles[role] = { ...base.roles[role], ...parsed.style };
  }
  return { theme: { name: base.name, roles }, problems };
}

/**
 * The theme `env` asks for. A non-empty `NO_COLOR` gives `mono`. Else
 * `ORC_COCKPIT_THEME` is a built-in name, or the path of a JSON file
 * `{ "base"?: "<built-in>", "roles"?: { "<role>": { ... } } }` read with
 * `readText` (null when it cannot be read); a file that cannot be read, is not
 * JSON or names an unknown base is a problem and gives `amber`. Any other field
 * of the file is a problem and is skipped. Unset gives `amber`.
 */
export function themeFromEnv(
  env: Record<string, string | undefined>,
  readText: (path: string) => string | null,
): { theme: Theme; problems: string[] } {
  if (env.NO_COLOR) return { theme: mono, problems: [] };
  const value = env.ORC_COCKPIT_THEME?.trim();
  if (!value) return { theme: amber, problems: [] };
  if (isBuiltInName(value)) return { theme: BUILT_IN_THEMES[value], problems: [] };
  const fail = (why: string) => ({ theme: amber, problems: [`ORC_COCKPIT_THEME: ${why}; using amber`] });
  const text = readText(value);
  if (text === null) return fail(`'${value}' is not a built-in theme (${Object.keys(BUILT_IN_THEMES).join(', ')}) or a readable file`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(`${value} is not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(parsed)) return fail(`${value} must hold a JSON object with optional "base" and "roles"`);
  const base = parsed.base === undefined ? 'amber' : parsed.base;
  if (!isBuiltInName(base)) return fail(`${value}: unknown base ${JSON.stringify(base)} (built-in themes: ${Object.keys(BUILT_IN_THEMES).join(', ')})`);
  const unknownFields = Object.keys(parsed).filter((key) => key !== 'base' && key !== 'roles').map((key) => `unknown field '${key}' (fields: base, roles)`);
  const { theme, problems } = resolveTheme(BUILT_IN_THEMES[base], parsed.roles);
  return { theme, problems: [...unknownFields, ...problems].map((problem) => `ORC_COCKPIT_THEME ${value}: ${problem}`) };
}

const DEFAULT_COLOR: Color = Object.freeze({ type: 'default' });

/** A role's full cell style: unset attributes false, unset colours `default`. */
export function styleOf(theme: Theme, role: ThemeRole): CellStyle {
  const style = theme.roles[role];
  return {
    bold: style.bold ?? false, dim: style.dim ?? false, italic: false, underline: style.underline ?? false, blink: false,
    inverse: style.inverse ?? false, invisible: false, strikethrough: false,
    fg: style.fg ?? DEFAULT_COLOR, bg: style.bg ?? DEFAULT_COLOR,
  };
}
