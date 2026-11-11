import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CellStyle, Color } from './screen.ts';
import {
  BUILT_IN_THEMES, DEFAULT_THEME, THEME_ROLES, attentionRole, badgeRole, parseThemeColor, phaseRole, projectStateRole,
  resolveTheme, styleOf, themeFromEnv, type ThemeRole,
} from './theme.ts';

const ROLES: ThemeRole[] = [
  'chrome.border', 'chrome.borderFocus', 'chrome.title', 'chrome.titleFocus', 'chrome.meta',
  'text.primary', 'text.muted', 'text.accent', 'text.edge',
  'row.cursor', 'button', 'button.attention', 'tab.active', 'tab.close', 'error',
  'status.active', 'status.active.badge', 'status.attention', 'status.attention.badge',
  'status.warn', 'status.warn.badge', 'status.error', 'status.error.badge', 'status.idle', 'status.idle.badge',
];

const DEFAULT: Color = { type: 'default' };
const palette = (index: number): Color => ({ type: 'palette', index });
const PLAIN: CellStyle = {
  bold: false, dim: false, italic: false, underline: false, blink: false, inverse: false, invisible: false, strikethrough: false,
  fg: DEFAULT, bg: DEFAULT,
};
const cell = (over: Partial<CellStyle>): CellStyle => ({ ...PLAIN, ...over });
const noFile = () => null;

describe('roles', () => {
  it('lists the closed role set', () => {
    expect([...THEME_ROLES].sort()).toEqual([...ROLES].sort());
  });

  it.each(Object.entries(BUILT_IN_THEMES))('%s defines every role and nothing else', (_name, theme) => {
    expect(Object.keys(theme.roles).sort()).toEqual([...ROLES].sort());
  });

  it('defaults to amber', () => {
    expect(DEFAULT_THEME).toBe(BUILT_IN_THEMES.amber);
  });
});

describe('state to role', () => {
  it('maps project states', () => {
    expect(projectStateRole('running')).toBe('status.active');
    expect(projectStateRole('connecting')).toBe('status.idle');
    expect(projectStateRole('stopped')).toBe('status.warn');
    expect(projectStateRole('stale')).toBe('status.error');
    expect(projectStateRole('incompatible')).toBe('status.error');
  });

  it('maps attention kinds', () => {
    expect(attentionRole('permission_prompt')).toBe('status.attention');
    expect(attentionRole('question')).toBe('status.attention');
    expect(attentionRole('stalled')).toBe('status.error');
    expect(attentionRole('no_progress')).toBe('status.warn');
  });

  it('maps run phases', () => {
    for (const phase of ['explore', 'implement', 'complete', 'finalize']) expect(phaseRole(phase)).toBe('status.active');
    expect(phaseRole('review')).toBe('status.warn');
    expect(phaseRole('queued')).toBe('status.idle');
    expect(phaseRole(null)).toBe('status.idle');
    expect(phaseRole(undefined)).toBe('status.idle');
  });

  it('names the badge variant', () => {
    expect(badgeRole('status.warn')).toBe('status.warn.badge');
  });
});

describe('colours', () => {
  it('parses default, palette indices and hex', () => {
    expect(parseThemeColor('default')).toEqual(DEFAULT);
    expect(parseThemeColor(0)).toEqual(palette(0));
    expect(parseThemeColor(255)).toEqual(palette(255));
    expect(parseThemeColor('#FFb000')).toEqual({ type: 'rgb', r: 255, g: 176, b: 0 });
  });

  it.each([256, -1, 1.5, '#fff', '#gggggg', 'red', '3', null, true])('rejects %j', (value) => {
    expect(parseThemeColor(value)).toBeNull();
  });
});

describe('built-in themes', () => {
  it('amber uses the plan colours and paints no default text background', () => {
    const amber = BUILT_IN_THEMES.amber;
    expect(styleOf(amber, 'chrome.border').fg).toEqual({ type: 'rgb', r: 0xff, g: 0xb0, b: 0x00 });
    expect(styleOf(amber, 'chrome.borderFocus').fg).toEqual({ type: 'rgb', r: 0xff, g: 0xc2, b: 0x33 });
    expect(styleOf(amber, 'status.active')).toEqual(cell({ fg: { type: 'rgb', r: 0x00, g: 0xff, b: 0x66 } }));
    expect(styleOf(amber, 'status.active.badge')).toEqual(cell({
      bold: true, fg: { type: 'rgb', r: 0x00, g: 0xff, b: 0x66 }, bg: { type: 'rgb', r: 0x00, g: 0x33, b: 0x14 },
    }));
    for (const role of ['chrome.border', 'chrome.title', 'chrome.meta', 'text.primary', 'text.muted', 'text.edge'] as const) {
      expect(styleOf(amber, role).bg).toEqual(DEFAULT);
    }
  });

  it('classic equals the styles in widgets.ts, app.ts and frame.ts', () => {
    const classic = BUILT_IN_THEMES.classic;
    const expected: Record<ThemeRole, CellStyle> = {
      'chrome.border': cell({ dim: true }), // MUTED
      'chrome.borderFocus': cell({ bold: true, fg: palette(6) }), // FOCUS_BORDER
      'chrome.title': cell({ bold: true }), // BOLD, app.ts TITLE_STYLE
      'chrome.titleFocus': cell({ bold: true, inverse: true, fg: palette(6) }), // FOCUS_TITLE
      'chrome.meta': cell({ dim: true }), // footer, hint, marker, rule (the notice maps to status.warn)
      'text.primary': PLAIN,
      'text.muted': cell({ dim: true }), // MUTED, app.ts MUTED_STYLE
      'text.accent': cell({ bold: true }), // names, the active project
      'text.edge': cell({ dim: true }), // frame.ts EDGE_STYLE
      'row.cursor': cell({ inverse: true }),
      'button': cell({ underline: true, fg: palette(6) }), // EXPLORER_BUTTON
      'button.attention': cell({ bold: true, inverse: true, fg: palette(3) }), // ATTENTION_BUTTON
      'tab.active': cell({ bold: true, inverse: true }),
      'tab.close': cell({ fg: palette(1) }),
      'error': cell({ bold: true, fg: palette(1) }), // ERROR
      // STATE_COLOR: running green, connecting cyan, stopped yellow, stale/incompatible red
      'status.active': cell({ fg: palette(2) }),
      'status.idle': cell({ fg: palette(6) }),
      'status.warn': cell({ fg: palette(3) }),
      'status.error': cell({ fg: palette(1) }),
      'status.attention': cell({ fg: palette(3) }),
      // the agent tag: bold, inverse, the state's colour (the tab badge and attention count were bold only)
      'status.active.badge': cell({ bold: true, inverse: true, fg: palette(2) }),
      'status.idle.badge': cell({ bold: true, inverse: true, fg: palette(6) }),
      'status.warn.badge': cell({ bold: true, inverse: true, fg: palette(3) }),
      'status.error.badge': cell({ bold: true, inverse: true, fg: palette(1) }),
      'status.attention.badge': cell({ bold: true, inverse: true, fg: palette(3) }),
    };
    for (const role of ROLES) expect(styleOf(classic, role), role).toEqual(expected[role]);
  });

  it('mono sets no colour on any role', () => {
    for (const role of ROLES) {
      expect(BUILT_IN_THEMES.mono.roles[role].fg, role).toBeUndefined();
      expect(BUILT_IN_THEMES.mono.roles[role].bg, role).toBeUndefined();
    }
  });

  it('mono tells every status role and badge apart by attributes, and from the cursor row', () => {
    const mono = BUILT_IN_THEMES.mono;
    const statuses = ['status.active', 'status.attention', 'status.warn', 'status.error', 'status.idle'] as const;
    const keys = [...statuses, ...statuses.map(badgeRole), 'row.cursor' as const].map((role) => JSON.stringify(styleOf(mono, role)));
    expect(new Set(keys).size).toBe(keys.length);
    for (const role of statuses) expect(styleOf(mono, badgeRole(role))).toEqual({ ...styleOf(mono, role), inverse: true });
  });
});

describe('styleOf', () => {
  it('fills unset attributes and colours', () => {
    expect(styleOf(BUILT_IN_THEMES.classic, 'text.primary')).toEqual(PLAIN);
  });
});

describe('resolveTheme', () => {
  const base = BUILT_IN_THEMES.classic;

  it('returns the base unchanged without overrides', () => {
    expect(resolveTheme(base, undefined)).toEqual({ theme: base, problems: [] });
  });

  it('merges per role: given fields replace, the rest keep the base', () => {
    const { theme, problems } = resolveTheme(base, { 'chrome.borderFocus': { fg: '#102030', underline: true }, 'text.primary': { fg: 7 } });
    expect(problems).toEqual([]);
    expect(theme.name).toBe('classic');
    expect(styleOf(theme, 'chrome.borderFocus')).toEqual(cell({ bold: true, underline: true, fg: { type: 'rgb', r: 0x10, g: 0x20, b: 0x30 } }));
    expect(styleOf(theme, 'text.primary')).toEqual(cell({ fg: palette(7) }));
    expect(theme.roles['chrome.title']).toBe(base.roles['chrome.title']);
  });

  it('does not change the base theme', () => {
    resolveTheme(base, { 'text.primary': { bold: true } });
    expect(base.roles['text.primary']).toEqual({});
  });

  it.each([
    ['unknown role', { 'text.loud': { bold: true } }, 'text.loud', null],
    ['bad hex', { error: { fg: '#12345' } }, 'error', 'error'],
    ['palette index out of range', { error: { bg: 300 } }, 'error', 'error'],
    ['non-boolean attribute', { error: { bold: 'yes' } }, 'error', 'error'],
    ['unknown field', { error: { italic: true } }, 'italic', 'error'],
    ['non-object style', { error: 'red' }, 'error', 'error'],
  ] as const)('%s is a problem and keeps the base value', (_case, overrides, mention, role) => {
    const { theme, problems } = resolveTheme(base, { ...overrides, 'text.primary': { bold: true } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(mention);
    if (role) expect(theme.roles[role]).toEqual(base.roles[role]);
    expect(theme.roles['text.primary']).toEqual({ bold: true });
  });

  it('keeps the base role when one of its fields is invalid', () => {
    const { theme, problems } = resolveTheme(base, { error: { fg: 'nope', underline: true } });
    expect(problems).toHaveLength(1);
    expect(theme.roles.error).toEqual(base.roles.error);
  });

  it('reports a roles value that is not an object', () => {
    const { theme, problems } = resolveTheme(base, ['error']);
    expect(theme).toBe(base);
    expect(problems).toHaveLength(1);
  });
});

describe('themeFromEnv', () => {
  const files = (contents: Record<string, string>) => (path: string) => contents[path] ?? null;

  it('gives amber when unset or empty', () => {
    expect(themeFromEnv({}, noFile)).toEqual({ theme: BUILT_IN_THEMES.amber, problems: [] });
    expect(themeFromEnv({ ORC_COCKPIT_THEME: '  ' }, noFile)).toEqual({ theme: BUILT_IN_THEMES.amber, problems: [] });
  });

  it('gives mono for a non-empty NO_COLOR, over ORC_COCKPIT_THEME', () => {
    expect(themeFromEnv({ NO_COLOR: '1', ORC_COCKPIT_THEME: 'classic' }, noFile)).toEqual({ theme: BUILT_IN_THEMES.mono, problems: [] });
  });

  it('ignores an empty NO_COLOR', () => {
    expect(themeFromEnv({ NO_COLOR: '', ORC_COCKPIT_THEME: 'classic' }, noFile).theme).toBe(BUILT_IN_THEMES.classic);
  });

  it.each(['amber', 'classic', 'mono'] as const)('takes the built-in name %s', (name) => {
    expect(themeFromEnv({ ORC_COCKPIT_THEME: name }, noFile)).toEqual({ theme: BUILT_IN_THEMES[name], problems: [] });
  });

  it('reads a theme file with a base and roles', () => {
    const read = files({ '/t.json': JSON.stringify({ base: 'mono', roles: { 'text.accent': { underline: true } } }) });
    const { theme, problems } = themeFromEnv({ ORC_COCKPIT_THEME: '/t.json' }, read);
    expect(problems).toEqual([]);
    expect(theme.name).toBe('mono');
    expect(theme.roles['text.accent']).toEqual({ bold: true, underline: true });
  });

  it('bases a theme file on amber by default', () => {
    const { theme, problems } = themeFromEnv({ ORC_COCKPIT_THEME: '/t.json' }, files({ '/t.json': '{}' }));
    expect(problems).toEqual([]);
    expect(theme).toEqual(BUILT_IN_THEMES.amber);
  });

  it('reports role problems from the file and keeps the rest', () => {
    const read = files({ '/t.json': JSON.stringify({ base: 'classic', roles: { nope: {}, button: { bold: true } } }) });
    const { theme, problems } = themeFromEnv({ ORC_COCKPIT_THEME: '/t.json' }, read);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^ORC_COCKPIT_THEME \/t\.json: unknown role 'nope'/);
    expect(theme.roles.button).toEqual({ fg: palette(6), underline: true, bold: true });
  });

  it('reports a file field other than base and roles and keeps the rest', () => {
    const read = files({ '/t.json': JSON.stringify({ base: 'classic', role: { button: { bold: true } }, roles: { 'text.accent': { underline: true } } }) });
    const { theme, problems } = themeFromEnv({ ORC_COCKPIT_THEME: '/t.json' }, read);
    expect(problems).toEqual(["ORC_COCKPIT_THEME /t.json: unknown field 'role' (fields: base, roles)"]);
    expect(theme.name).toBe('classic');
    expect(theme.roles['text.accent']).toEqual({ bold: true, underline: true });
    expect(theme.roles.button).toEqual(BUILT_IN_THEMES.classic.roles.button);
  });

  it.each([
    ['an unreadable file', files({}), /not a built-in theme .* or a readable file/],
    ['invalid JSON', files({ '/t.json': '{ nope' }), /not valid JSON/],
    ['a non-object', files({ '/t.json': '[1]' }), /JSON object/],
    ['an unknown base', files({ '/t.json': '{"base":"neon"}' }), /unknown base "neon"/],
    ['a null base', files({ '/t.json': '{"base":null}' }), /unknown base null/],
  ])('gives amber and a problem for %s', (_case, read, message) => {
    const { theme, problems } = themeFromEnv({ ORC_COCKPIT_THEME: '/t.json' }, read);
    expect(theme).toBe(BUILT_IN_THEMES.amber);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
  });
});

describe('docs/configuration.md', () => {
  it('lists every role in the ORC_COCKPIT_THEME row', () => {
    const docs = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf8');
    const row = docs.split('\n').find((line) => line.startsWith('| `ORC_COCKPIT_THEME` |')) ?? '';
    const missing = THEME_ROLES.filter((role) => !role.endsWith('.badge') && !row.includes(`\`${role}\``));
    expect(missing).toEqual([]);
    expect(row).toContain('each also with a `.badge` variant');
  });
});

describe('purity', () => {
  it('imports no fs and reads no process.env', () => {
    const source = readFileSync(new URL('./theme.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from 'node:|from 'fs'|require\(/);
    expect(source).not.toMatch(/process\.env/);
  });
});
