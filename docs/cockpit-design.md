# Cockpit design

How the cockpit (`orc cockpit`, `orc start-session`) styles and lays out what it draws itself. The panes it shows draw themselves; the theme does not reach them. Keys and behaviour: [cli.md](cli.md) (`cockpit`). Settings: [configuration.md](configuration.md) (Cockpit theme).

## Roles

A widget asks for a role, never for a colour (`lib/cockpit2/theme.ts`). A role's style is `fg`, `bg` and the attributes `bold`, `dim`, `underline`, `inverse`; unset colours are the terminal's default, unset attributes off.

| Role | Used for |
|---|---|
| `chrome.border` | Box borders (sidebar cards, the pane frame) |
| `chrome.borderFocus` | The border of the focused sidebar card and of the pane frame while the slot has the keys |
| `chrome.title` | Card titles (`[ AGENTS ]`), the first line of a message in the slot |
| `chrome.titleFocus` | The focused card's title |
| `chrome.meta` | A card's top-right count (`3 live`) |
| `text.primary` | Ordinary text: the header's project name, sidebar rows, the footer's `project › tab` |
| `text.muted` | Secondary text: separators, footer actions, run times, an agent's activity, `+N more`, tab bar notices and markers |
| `text.accent` | `ORC` in the header, footer keys, agent names |
| `text.edge` | The marker column and row past the edge of a pane smaller than the slot |
| `row.cursor` | The focused card's cursor row (its attributes and background over the row's own colours) |
| `button` | Header entries (`tasks`) |
| `button.attention` | The header's attention badge (`! N`) |
| `tab.active` | The active tab's block in the tab strip |
| `tab.inactive` | The other tabs' blocks in the tab strip |
| `tab.close` | A tab's `×` |
| `error` | Errors in the tab bar (a refused tab change, a failed save) |
| `status.active`, `status.attention`, `status.warn`, `status.error`, `status.idle` | A state's text and an expanded agent's border |
| `<status role>.badge` | A state's badge: `[RUNNING]`, `[QUESTION]`, `!N`, tab badges |

Which status role a state gets is decided in `theme.ts` only:

| State | Role |
|---|---|
| project `running` / `connecting` / `stopped` / `stale`, `incompatible` | active / idle / warn / error |
| attention `permission_prompt`, `question` / `no_progress` / `stalled` | attention / warn / error |
| run phase `explore`, `implement`, `complete`, `finalize` / `review` / other | active / warn / idle |

## Built-in themes

| Theme | Look |
|---|---|
| `amber` (default) | Amber chrome on the terminal's own background; RGB colours. Backgrounds only for badges, the cursor row and the attention badge |
| `classic` | The cockpit's earlier look: the 16 basic colours with bold, dim and inverse |
| `mono` | No colour at all; states differ by bold, dim, underline and inverse, and their text labels carry the meaning. `NO_COLOR` selects it |

Without true colour (`COLORTERM` other than `truecolor`/`24bit`) RGB colours are drawn as the nearest of the 256 xterm colours.

## Theme files

`ORC_COCKPIT_THEME` names a built-in theme or a JSON file: `base` (a built-in theme, default `amber`) and `roles`, each role's fields merged over the base's. A colour is `"#rrggbb"`, a palette index 0–255 or `"default"`.

```json
{
  "base": "mono",
  "roles": {
    "chrome.border": { "fg": "#5f87af" },
    "status.error.badge": { "fg": 15, "bg": "#af0000", "bold": true }
  }
}
```

A file that cannot be read or parsed, or names an unknown base, is reported and the cockpit draws in `amber`. An unknown role, field or bad value is reported and that role keeps its base style.

## Layout

```
┌ header: 1 row, full width ─────────────────────────────────┐
│ sidebar   │ tab strip: 1 row                               │
│ 34 cols   │┌──────────────────────────────────────────────┐│
│ Project   ││ slot: the active tab's pane, in the pane     ││
│ Other     ││ frame                                        ││
│ projects  ││                                              ││
│ Agents    │└──────────────────────────────────────────────┘│
└ footer: 1 row, full width ─────────────────────────────────┘
```

`computeLayout` in `lib/cockpit2/app.ts`. The slot keeps at least 20 columns and 3 rows. On a short terminal rows go, in this order: the footer, the header, then the tab strip. On a narrow one the sidebar narrows.

The tab strip is one row of solid blocks, one per tab, the tabs' side borders drawn as blank gaps: the active tab in `tab.active`, the others in `tab.inactive`, a tab's badge and `×` keeping their colour on its fill; overflow markers and notices are in `text.muted`, and an error takes the whole row. The pane frame (`paneFrame`, drawn by `drawPaneFrame` in `lib/cockpit2/chrome.ts`) is a plain box around the slot, its top border on its own row under the tab strip, in `chrome.border` (`chrome.borderFocus` while the slot has the keys). It costs two columns and two rows, so it is drawn only while the slot inside it keeps 20x3; otherwise the slot takes the whole area. At 80x24 the header is row 0, the tab strip row 1, the frame rows 2 to 22 (46x21 at (34,2)), the slot inside it 44x19 at (35,3) and the footer row 23; the frame's cells take no clicks.

The sidebar is three cards (`lib/cockpit2/sidebarCards.ts`): Project (the active project's coordinator state, worker capacity and, only while there is one, a notice row), Other projects (one row each) and Agents (one row each, a second row for an agent needing attention; a row too narrow for the agent's role drops the role whole rather than cutting it). Space or a click on an agent's `[+]` expands it into a box with its task, phase, provider, activity or question and the open key. When rows run short, Other projects shrinks to a `+N more` line before Agents loses rows; the cursor's row (an expanded agent's whole block) stays in view.
