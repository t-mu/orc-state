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
| `orc` (default) | The moonfly palette (an iTerm2 colour preset) with amber `#ffb000` chrome (the focus border the same amber, bold). Two surfaces: the sidebar's cards, the tab strip's rows above its gap row and the agent pane's box sit on a panel `#161616`, a shade above the near-black `#080808` canvas around them (header, gutter, the tab strip's gap row, footer). While the cockpit runs it sets the terminal's own background to the panel, and its text, cursor and 16 ANSI colours (OSC 11, 10, 12, 4), so the agents' output sits on the panel without painting, and resets them to the terminal's profile on exit (OSC 104, 110, 111, 112), crash and signal included. The cockpit paints both surfaces itself on its own cells left at the default background (never the slot), so the elevation shows even where a terminal ignores those sequences |
| `amber` | Amber chrome on the terminal's own background; RGB colours. Backgrounds only for badges, the cursor row and the attention badge |
| `classic` | The cockpit's earlier look: the 16 basic colours with bold, dim and inverse |
| `mono` | No colour at all; states differ by bold, dim, underline and inverse, and their text labels carry the meaning. `NO_COLOR` selects it |

Without true colour (`COLORTERM` other than `truecolor`/`24bit`) RGB colours are drawn as the nearest of the 256 xterm colours.

## Theme files

`ORC_COCKPIT_THEME` names a built-in theme or a JSON file: `base` (a built-in theme, default `orc`) and `roles`, each role's fields merged over the base's; a file based on `orc` keeps its terminal colours. A colour is `"#rrggbb"`, a palette index 0–255 or `"default"`.

```json
{
  "base": "mono",
  "roles": {
    "chrome.border": { "fg": "#5f87af" },
    "status.error.badge": { "fg": 15, "bg": "#af0000", "bold": true }
  }
}
```

A file that cannot be read or parsed, or names an unknown base, is reported and the cockpit draws in `orc`. An unknown role, field or bad value is reported and that role keeps its base style.

## Layout

```
┌ header: 1 row, full width ─────────────────────────────────┐
│ sidebar   ┊ ▄▄▄▄▄▄▄▄▄▄ ▄▄▄▄▄▄▄▄▄▄▄▄ tab strip: 4 rows,     │
│ 34 cols   ┊ █1 master█ █2 w1 ! Q ×█ a label row capped by  │
│ (drag the ┊ ▀▀▀▀▀▀▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀▀ half blocks, 1-col gaps│
│  gutter)  ┊                         a blank gap row        │
│ Project   ┊┌─ [ W1 ] task-1 · implement ───── [QUESTION] ─┐│
│ Other     ┊│ slot: the active tab's pane, inside          ││
│ projects  ┊│ the pane box                                 ││
│ Agents    ┊└──────────────────────────────────────────────┘│
└ footer: 1 row, full width ─────────────────────────────────┘
```

`computeLayout` in `lib/cockpit2/app.ts`. The slot keeps at least 20 columns and 3 rows. A blank gutter (`┊` above) separates the sidebar from the tab strip and the pane box: two columns from 100 terminal columns, one from 60, none below that or without a sidebar.

The gutter is the divider's handle: a left press on it grabs the divider, dragging moves a `┃` preview line (`chrome.borderFocus`) over the gutter's rows, and the release sets the sidebar's width (kept within 24 to 60 columns, and narrowed further when the slot would fall below its minimum), resizing the shown window once. A click without a drag changes nothing; two presses within 400 ms reset the width to the default 34. A dragged width is saved in `view-state.json` and restored at start; the default is not written. On a short terminal rows go, in this order: the footer, the tab strip's other rows (the gap row, then the top cap, then the bottom cap), the header, then the tab strip's label row. On a narrow one the sidebar narrows.

The tab strip is four rows: one block per tab on the label row (its second row), with one blank column (`TAB_GAP` in `lib/tui/tabBarModel.ts`) between blocks, the active tab in `tab.active`, the others in `tab.inactive`, each holding its number, label, badge and `×`, a tab's badge and `×` keeping their colour on its fill. The row above a block gets `▄` and the row below `▀` in the fill colour (foreground the role's background, default background), so the block reads as two rows tall; a role with no background but `inverse` (the active tab in `classic` and `mono`) gets the caps in the default style, and one with neither (their inactive tabs) gets none. The fourth row stays blank, a gap between the tabs and the pane box. Overflow markers and notices are in `text.muted` on the label row, and an error takes the label row instead of the tabs. With a project open (and the cockpit able to start sessions on its private server) a `+` block in `tab.inactive` (bold `+`, with its caps) follows the last tab or the right overflow marker after one gap column; the tabs make room for it, and it is left out when the strip is too narrow. A click on it opens a shell tab: the user's login shell (`$SHELL -l`, else `/bin/sh`) in the project's checkout (`target_repo_root`), in a session `shell-<project>-<N>` on the private `orc-explorer` server, without the cockpit's `ORC_*` variables. A shell tab (id `shell:N`, the first free number) is labelled `shell N` with no mode mark, types like the master (keys and the mouse reach it at once) and shows `[ SHELL N ]` with the project and its checkout on the pane box; closing it (`×`) kills its session, and a shown shell tab whose shell exited (`exit`) closes. A click in a tab's columns on any tab strip row selects its tab (`×` closes it); the gaps take no action. The pane box (`paneFrame`, drawn by `drawPaneBox` in `lib/cockpit2/chrome.ts`) is a full box around the slot in `chrome.border` (`chrome.borderFocus` while the slot has the keys), its top border the shown tab's header: `[ TITLE ]`, then facts joined by ` · ` in `text.muted` (whole facts only, in order, while they fit), then a status badge flush right (` [BADGE] ─┐`, dropped when it would meet the title). An agent tab shows its agent id, task (or role), phase, provider and run time, badged with its attention kind; an agent not running shows `not running`; the master tab shows `master`, the project, `workers used/configured` and the open task counts (or `no open tasks`), badged `coordinator <state>`; the task explorer shows `tasks`, `task explorer` and the project. The box costs two columns and two rows, so it is drawn only while the slot inside it keeps 20x3; otherwise the slot takes the whole area. At 80x24 the header is row 0, the tab strip rows 1 to 4 (top cap 1, labels 2, bottom cap 3, gap 4), the gutter column 34, the box rows 5 to 22 (45x18 at (35,5), its top border the header), the slot inside it 43x16 at (36,6) and the footer row 23; the box's cells take no clicks.

Every shown tab owns its window: the master's, a worker's or a scout's window (and the task explorer's) is sized to the slot when its tab is shown and whenever the slot changes (a terminal resize or a dragged divider), so its screen fills the slot. A hidden tab's window keeps its last size; a window resized from outside the cockpit while shown is cropped, or padded with a dim edge marker (`┊`, `┈`), into the slot until the slot next changes.

The sidebar is three cards (`lib/cockpit2/sidebarCards.ts`): Project (the active project's coordinator state, worker capacity and, only while there is one, a notice row), Other projects (one row each) and Agents (one row each, a second row for an agent needing attention; a row too narrow for the agent's role drops the role whole rather than cutting it). Space or a click on an agent's `[+]` expands it into a box with its task, phase, provider, activity or question and the open key. When rows run short, Other projects shrinks to a `+N more` line before Agents loses rows; the cursor's row (an expanded agent's whole block) stays in view.
