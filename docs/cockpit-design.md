# Cockpit design

How the cockpit (`orc cockpit`, `orc start-session`) styles and lays out what it draws itself. The panes it shows draw themselves; the theme does not reach them. Keys and behaviour: [cli.md](cli.md) (`cockpit`). Settings: [configuration.md](configuration.md) (Cockpit theme).

## Roles

A widget asks for a role, never for a colour (`lib/cockpit2/theme.ts`). A role's style is `fg`, `bg` and the attributes `bold`, `dim`, `underline`, `inverse`; unset colours are the terminal's default, unset attributes off.

| Role | Used for |
|---|---|
| `chrome.border` | Box borders (sidebar cards, the pane frame) |
| `chrome.borderFocus` | The border of the focused sidebar card and of the pane frame while the slot has the keys; the tab strip's `▸` highlight mark |
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
| `button.danger` | A destructive button: an expanded agent's `[ KILL ]`, the kill confirmation's `[ KILL ]` |
| `tab.active` | The active tab's block in the tab strip, an expanded agent's `[ OPEN ]` |
| `tab.inactive` | The other tabs' blocks in the tab strip |
| `tab.close` | A tab's `×` |
| `error` | Errors in the tab bar (a refused tab change, a failed save) |
| `status.active`, `status.attention`, `status.warn`, `status.error`, `status.idle` | A state's text and an expanded agent's border |
| `status.local` | The cockpit's own agent sessions in the Agents card (not the coordinator's): their `[LOCAL]` badge and an expanded session's border |
| `<status role>.badge` | A state's badge: `[RUNNING]`, `[QUESTION]`, `!N`, tab badges |

Which status role a state gets is decided in `theme.ts` only:

| State | Role |
|---|---|
| project `running` / `connecting` / `stopped` / `stale`, `incompatible` | active / idle / warn / error |
| attention `permission_prompt`, `question` / `no_progress` / `stalled` | attention / warn / error |
| run phase `explore`, `implement`, `complete`, `finalize` (or, without a phase, a run `in_progress` or a scout `running`) / `review` / other | active / warn / idle |
| an agent session of the cockpit's own (Agents card) running / ended | local / idle |

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
│ 34 cols   ┊ █ master █ █ w1 ! Q × █ a label row capped by  │
│ (drag the ┊ ▀▀▀▀▀▀▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀▀ half blocks, 1-col gaps│
│  gutter)  ┊                         a blank gap row        │
│ Projects  ┊┌─ [ W1 ] task-1 · implement ───── [QUESTION] ─┐│
│ Project   ┊│ slot: the active tab's pane, inside          ││
│ Agents    ┊│ the pane box                                 ││
│ (gap rows)┊└──────────────────────────────────────────────┘│
└ footer: 1 row, full width ─────────────────────────────────┘
```

`computeLayout` in `lib/cockpit2/app.ts`. The slot keeps at least 20 columns and 3 rows. A blank gutter (`┊` above) separates the sidebar from the tab strip and the pane box: two columns from 100 terminal columns, one from 60, none below that or without a sidebar.

The gutter is the divider's handle: a left press on it grabs the divider, dragging moves a `┃` preview line (`chrome.borderFocus`) over the gutter's rows, and the release sets the sidebar's width (kept within 24 to 60 columns, and narrowed further when the slot would fall below its minimum), resizing the shown window once. A click without a drag changes nothing; two presses within 400 ms reset the width to the default 34. A dragged width is saved in `view-state.json` and restored at start; the default is not written. On a short terminal rows go, in this order: the footer, the tab strip's other rows (the gap row, then the top cap, then the bottom cap), the header, then the tab strip's label row. On a narrow one the sidebar narrows.

The tab strip is four rows: one block per tab on the label row (its second row), with one blank column (`TAB_GAP` in `lib/tui/tabBarModel.ts`) between blocks, the active tab in `tab.active`, the others in `tab.inactive`, each holding its label, badge and `×` (no number: the order tells it, and `F1`-`F9` select by it), a tab's badge and `×` keeping their colour on its fill. The row above a block gets `▄` and the row below `▀` in the fill colour (foreground the role's background, default background), so the block reads as two rows tall; a role with no background but `inverse` (the active tab in `classic` and `mono`) gets the caps in the default style, and one with neither (their inactive tabs) gets none. The fourth row stays blank, a gap between the tabs and the pane box. Overflow markers and notices are in `text.muted` on the label row, and an error takes the label row instead of the tabs. With a project open (and the cockpit able to start sessions on its private server) a `+` block in `tab.inactive` (bold `+`, with its caps) follows the last tab or the right overflow marker after one gap column; the tabs make room for it, and it is left out when the strip is too narrow. A click on it opens a shell tab: the user's login shell (`$SHELL -l`, else `/bin/sh`) in the project's checkout (`target_repo_root`), in a session `shell-<project>-<N>` on the private `orc-explorer` server, without the cockpit's `ORC_*` variables. A shell tab (id `shell:N`, the first free number) is labelled `shell N` with no mode mark, types like the master (keys and the mouse reach it at once) and shows `[ SHELL N ]` with the project and its checkout on the pane box; closing it (`×`) kills its session, and a shown shell tab whose shell exited (`exit`) closes. A click in a tab's columns on any tab strip row selects its tab (`×` closes it); the gaps take no action. The tab strip takes the keys in the focus ring (the leader then `Tab`/`Shift-Tab`: pane, tab strip, sidebar): its highlight starts on the shown tab, `←`/`→` move it over the tabs and the `+` (wrapping), and the highlighted block gets a `▸` in its first column (`chrome.borderFocus` on the block's fill) and its label bold and underlined, so it does not rely on colour; `Enter` shows the tab and gives the pane the keys (on `+`: a new shell), `w` or `Delete` closes it, `Esc` or `↓` returns to the pane. The pane box (`paneFrame`, drawn by `drawPaneBox` in `lib/cockpit2/chrome.ts`) is a full box around the slot in `chrome.border` (`chrome.borderFocus` while the slot has the keys), its top border the shown tab's header: `[ TITLE ]`, then facts joined by ` · ` in `text.muted` (whole facts only, in order, while they fit), then a status badge flush right (` [BADGE] ─┐`, dropped when it would meet the title). An agent tab shows its agent id, task, phase, provider · model and run time, badged with its attention kind (a scout: its brief cut to 40 columns, `provider · model` with `default` for an unknown model, and run time); an agent not running shows `not running`; the master tab shows `master`, the project, `workers used/configured` and the open task counts (or `no open tasks`), badged `coordinator <state>`; the task explorer shows `tasks`, `task explorer` and the project. The box costs two columns and two rows, so it is drawn only while the slot inside it keeps 20x3; otherwise the slot takes the whole area. At 80x24 the header is row 0, the tab strip rows 1 to 4 (top cap 1, labels 2, bottom cap 3, gap 4), the gutter column 34, the box rows 5 to 22 (45x18 at (35,5), its top border the header), the slot inside it 43x16 at (36,6) and the footer row 23; the box's cells take no clicks.

Every shown tab owns its window: the master's, a worker's or a scout's window (and the task explorer's) is sized to the slot when its tab is shown and whenever the slot changes (a terminal resize or a dragged divider), so its screen fills the slot. A hidden tab's window keeps its last size; a window resized from outside the cockpit while shown is cropped, or padded with a dim edge marker (`┊`, `┈`), into the slot until the slot next changes.

The sidebar is three cards (`lib/cockpit2/sidebarCards.ts`), top to bottom, with one blank row between two cards (no card's: it shows the canvas):

```
┌─ [ PROJECTS ] ───────────── 2 ┐   every registered project: state badge, `!N` when
│ ▸ orc-state         [RUNNING] │   its agents need a human; `▸` and text.accent mark
│                               │   the active one; the add-project button (a spare
│   arek-on-trail        [IDLE] │   row spaces the projects: Padding and spacing)
│ [ + ADD PROJECT ]             │
└───────────────────────────────┘
                                    gap
┌─ [ ORC-STATE ] ───────────────┐   the active project: coordinator state, worker
│ coordinator         [RUNNING] │   capacity, open task counts (`no open tasks`; no
│ workers 2/4                   │   row without its status), the notice only while
│ tasks 3 todo · 1 in progress  │   there is one, the settings button
│ [ SETTINGS ]                  │
└───────────────────────────────┘
                                    gap
┌─ [ AGENTS ] ──────── 2 live ──┐   every agent is a box in its status role,
│┌─────────────────────────────┐│   collapsed or expanded: its title row and,
││ [+] grommash  [PERMISSION]  ││   for one needing attention, its question
││     ? may I run npm test    ││   row; expanded, labelled rows (provider ·
│└─────────────────────────────┘│   model, the task, or a scout's brief, the
│┌─────────────────────────────┐│   activity when it says more than the row),
││ [-] boin worker 3m [IMPL…]  ││   or the question unlabelled, and two filled
││ model  claude · opus        ││   buttons one column apart go inside the
││ task   cockpit-style/foo    ││   same box, below the title row; the
││ doing  editing app.ts       ││   new-agent button
││ [ OPEN ] [ KILL ]           ││
│└─────────────────────────────┘│
│ [ + NEW AGENT ]               │
└───────────────────────────────┘
```

Card buttons: each card's action button sits on its last body row, just above its bottom border, whatever the card's height: `[ + ADD PROJECT ]` (Projects), `[ SETTINGS ]` (Project, only with an active project) and `[ + NEW AGENT ]` (Agents, only with an active project), all in `button`. A card's list takes the rows above its button, blank rows between when it is shorter, and scrolls there (`+N more`, the cursor's row kept in view). A click on a button's columns presses it: `[ SETTINGS ]` opens the active project's settings dialog, `[ + ADD PROJECT ]` and `[ + NEW AGENT ]` open the add-project and new-agent dialogs (Dialog layer, Agent sessions).

Padding and spacing: a terminal has no space between rows, so a card spends the blank rows its list leaves (never more: they are layout only) on air, in this order: one blank row between each two items (the projects, the Project card's info rows; never between two agent boxes, whose borders already set them apart, nor inside one), all of them or none so a list never looks half-spaced; then one between the top border and the first row; then one between the last row and the button. Short of rows they go in reverse (the bottom padding, the top padding, then the spacing) before an item goes behind `+N more`, and a list with items behind `+N more` has none. The card heights ignore them: the Agents card's need is its content and its button, so spacing never makes Agents grow at the others' expense, and Projects and the Project card never grow past their shares for it. Padding and spacing rows are blank: a click there does nothing and the cursor bar stays on the item's row. At 80x24 with two projects, three info rows and one agent (its box 3 rows) Projects spaces its two projects, the Project card has no spare row, and Agents has two, its top padding and one above its button.

Heights: the cards share the sidebar's rows (less the gaps) equally, the remainder going to Agents; Projects and the Project card never take more than their share. While the Agents content (its agents' boxes: 3 rows for a collapsed agent, 4 with a question row, an expanded one's whole box; and its button) does not fit its share, Agents takes rows from the others: first what their content leaves of their shares (each shrinks to its content), then Projects down to its least (a `+N more` window around its cursor, the active project while the keys are elsewhere, and its button). A card's least is its borders, one item (the cursor's) and its button, plus the `+N more` line when it has more items.

Agents: every agent, collapsed or expanded, is a box: a full border in the agent's status role (dim on a stale list), `┌──┐` on its own row, its title row inside the border (`│ [+] name … [BADGE] │`, the cursor bar's row), for an agent needing a human its question or reason row under its name (in the attention kind's role), and `└──┘`: 3 rows, 4 with the question. Two boxes sit border to border. A title row too narrow for the agent's role drops the role whole rather than cutting it. Space, `Enter`, `→`/`l` or a click anywhere in a collapsed box (its borders, its title row, its question row) expands it: its labelled rows and its buttons go inside the same box, below its title row (`[-]`), so the title row stays on its screen row and the boxes above it do not move while the Agents card keeps its rows (`←`/`h`, Space, `Enter` or a click anywhere in the expanded box but its buttons row collapse it; a click on the buttons row off its buttons moves the cursor to it). A click on a blank row targets nothing. The window shows whole boxes, keeping the cursor agent's box in view (an expanded one from its top border, down to its buttons row while the cursor is on them), and `+N more` counts the agents left out; a window too short for the cursor agent's collapsed box (or a single row for an expanded one off its buttons) shows its title row alone, without the box. A click on an agent never opens its tab: only its `[ OPEN ]` does; `F10` toggles the keys between the pane and the sidebar. Its rows carry a label in `text.muted`, padded to one width so the values (`text.primary`) line up: `model` with `provider · model` (`-` for an unknown provider, `default` for an unknown model: the provider CLI's own), `task` with the task ref when the agent has one, `brief` with a scout's brief (the first line of its objective, cut by display width), then the question or reason of an agent needing a human (unlabelled, the full width, in the attention kind's role: `? …`), else `doing` with its activity only when it says something (never the bare role, the task it falls back to, or the phase the badge shows; at most two lines, the second under the first), and the buttons: `[ OPEN ]` (`tab.active`) opens the agent's tab and gives it the keys, `[ KILL ]` (`button.danger`) kills it as `x` does, after a confirmation (Dialog layer). The buttons are a position of the keys' cursor (`SidebarNav.agentButton`): `↓` from an expanded agent's row lands on `[ OPEN ]`, `→`/`l` and `←`/`h` move between `[ OPEN ]` and `[ KILL ]`, `Enter` presses the focused one, `↑` returns to the agent's row and `↓` goes on to the next agent (or `[ + NEW AGENT ]`); `↑` from the next agent's row (or from `[ + NEW AGENT ]`) onto an expanded agent lands on its `[ OPEN ]`; `x` kills from either position, and collapsing the agent returns the cursor to its row. While the sidebar has the keys the focused button is bold with a `▸` (`text.accent`) in the column before it, as the confirm dialog marks its focused button, and the block's title row has no cursor bar; an Agents window too short for the block keeps its buttons row in view. The keys move in three boxes, one per card, `Tab` and `Shift-Tab` cycling them: Projects (by project, `Enter` opens it; `↓` past the last project lands on `[ + ADD PROJECT ]`), Project (only its settings button, `Enter` presses it) and Agents (by agent, `Enter` expanding or collapsing it; `↓` past the last agent lands on `[ + NEW AGENT ]`). `Enter` on a button presses it; `↑` returns to the last item; an empty list's cursor is on its button. When rows run short, Agents keeps the cursor agent's row (its box when there is room, an expanded agent's whole box), a `+N more` line and its button before the Project card goes down to its least (its coordinator row and its button); Projects goes last unless the keys are in it. Rows the Agents window leaves unused beside an expanded block go back to a shrunk Project card, then a shrunk Projects, up to their shares. The gaps count in the rows (two at 80x24) and go before the Project card goes below its content (or share), Projects goes or Agents is down to its least.

Agents also lists the active project's agent sessions (Agent sessions), after the coordinator's workers and scouts, in tab order: they are not the coordinator's, and each row says so with a muted `◇` before its tab label and a `[LOCAL]` badge (`status.local`), `[ENDED]` (`status.idle`) once its session ended in a tab not shown since; its run time since its tab was opened, when known (`agentTabs`' `openedAt`), sits before the badge: `[+] ◇ claude 1   2m [LOCAL]`, `[+] ◇ critic · claude [LOCAL]`. The card's count gives them apart (`2 live · 1 local`), and they never count in the header's attention badge or `F11`'s queue. Expanded, a session's box (border in its badge's role) has `model` with `<provider> · default` (sessions run the CLI's default model), `type fresh session` or `agent <name>` for a custom agent, the muted note `not managed by the coordinator` (wrapped in a narrow card) and the same buttons, reached the same way: `[ OPEN ]` shows its tab (a click on its row or `Enter` on it expands or collapses it); `[ KILL ]` (or `x`) asks `Kill <label>? Its session ends and its tab closes.` and, confirmed, closes its tab, which ends the session. A session whose tab closed leaves the list. Its sidebar key (`local:<project>/<tab>`) never equals an agent's.

## Dialog layer

A dialog is drawn over everything else: the frame behind it is dimmed (`dim` on every cell), the dialog is a box (`drawBox`, focused border) filled with the theme's panel surface (the default background without surfaces), centred, at most 52 columns (the help dialog 72), and the terminal cursor is hidden. While it is open it takes every key and click; nothing reaches the pane, the sidebar or the tab strip, and pastes and other mouse events are dropped.

There are five dialogs, one open at a time, sharing this routing.

The help dialog (`lib/cockpit2/helpDialog.ts`, the leader then `?`), titled `[ HELP ]` with `Esc: close`, lists every key with the configured labels: the leader's table, the direct keys, then the sidebar, tab strip, pane and dialog keys; headings in `chrome.title`, keys in `text.accent`, what they do in `text.primary`. Taller than the terminal it scrolls (`↑`/`↓`, `j`/`k`, `PageUp`/`PageDown`, `Home`/`End`), with `↑`/`↓` in `text.muted` on its right border while lines are above or below; `Esc`, `q` or `Enter` close it.

The kill confirmation (`lib/cockpit2/confirmDialog.ts`, a generic confirmation), titled `[ KILL · <AGENT> ]`, says what killing does: for a worker `Kill <agent>? Its run is cancelled and <task> goes back to the backlog (task reset); a new worker picks it up.`, for a scout `Kill <agent>? Its session ends and it is removed.` Its buttons are `[ KILL ]` (`button.danger`) and `[ CANCEL ]` (`tab.inactive`), a `▸` before the one under the cursor, which starts on `[ KILL ]`; arrows, `h`/`l`, `j`/`k`, `Tab` and `Space` move between them, `Enter` or a click presses one, `Esc` or `q` cancel. Confirmed, a worker's task is reset (`orc --project=<id> task-reset <task> --json`) and a scout removed (the `remove-scout` operator mutation, through the project's coordinator, applied directly when none runs); while it runs the dialog shows `Killing…` and ignores keys, a failure keeps it open with the error's first line (`error`), success closes it. A worker without a task, or a cockpit without the agent actions, refuses in the tab bar instead.

The project settings dialog (`lib/cockpit2/settingsDialog.ts`), opened by the Project card's `[ SETTINGS ]` button (`Enter` or a click), titled `[ SETTINGS · <PROJECT> ]`. It edits the project-scope registry settings ([configuration.md](configuration.md), Settings), reading the effective values (`orc project config list`) when it opens:

| Field | Key | Choices | Applies |
|---|---|---|---|
| Max workers | `worker_pool.max_workers` | 0 to 8 | at once |
| Merge | `coordinator.merge_strategy` | `direct`, `pr` | after a coordinator restart |
| PR provider (only while Merge is `pr`) | `coordinator.pr_provider` | `none`, `github` | after a coordinator restart |
| Default worker provider | `worker_pool.provider` | `claude`, `codex`, `gemini` | at once |
| Default worker model | `worker_pool.provider_models.<provider>` | claude: `sonnet`, `opus`, `haiku`; codex: `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-luna`; gemini: the CLI aliases `auto`, `pro`, `flash`, `flash-lite` and `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-3-flash-preview` (a stored model outside the lists stays selectable) | at once |
| Execution mode | `worker_pool.execution_mode` | `full-access`, `sandbox` | after a coordinator restart |

A stored value outside the choices stays selectable. Switching the provider shows that provider's stored model (else `worker_pool.model`) and writes no model. Keys: `↑`/`↓`, `j`/`k`, `Tab`/`Shift-Tab` move over the fields and buttons; `←`/`→`, `h`/`l` or `Space` change the field under the cursor (between buttons they move); a click on a field's value changes it, on its label focuses it. `Enter` on a field saves, on a button presses it; `Esc` or `q` cancel. Changed values are drawn in `text.accent`; a note says whether the changes apply at once or after a coordinator restart (`status.warn`). The buttons are `[ SAVE ]`, `[ SAVE & RESTART ]` (only while a changed field needs a restart) and `[ CANCEL ]`. Saving writes only the changed shown fields (`none` stores null); save & restart then runs `orc --project=<id> coordinator restart`. `pr` merge without a PR provider is refused with an error in the dialog. While saving or restarting the dialog ignores keys; a failed write or restart keeps it open with the error (`error`). It closes when its project is removed from the registry.

The add-project and new-agent dialogs are forms (`lib/cockpit2/formDialog.ts`): labelled rows, a note row (an error in `error`, what is under way in `text.muted`) and buttons (the first in `button`, `[ CANCEL ]` in `text.muted`, the one under the cursor in `tab.active`). A text field (`lib/cockpit2/textField.ts`) is underlined, shows a placeholder in `text.muted` while empty and unfocused, scrolls to keep its caret in view, and while focused shows the caret as a reverse cell. While a text field has the cursor every printable character (`h`, `j`, `q` and Space included) and a paste (one line: its line breaks and control characters dropped) go into it; `←`/`→`, `Home`, `End`, `Backspace`, `Delete` edit it and `Ctrl-U` clears it. Elsewhere the keys are the settings dialog's: `↑`/`↓`, `Tab`/`Shift-Tab` (and `j`/`k` off a text field) move, `←`/`→`, `h`/`l`, Space change a choice or move between buttons, a click on a choice's value changes it, `Enter` on a field presses the first button, `Esc` (and `q` off a text field) cancels. While the pressed button's work runs the dialog ignores input; a failure keeps it open with the error's first line.

The add-project dialog (`lib/cockpit2/addProjectDialog.ts`), titled `[ ADD PROJECT ]`, opened by the Projects card's `[+ ADD PROJECT]` (the app's `openAddProject()`): Path (required, absolute: a git checkout on this machine), Name (optional; the folder's name when blank), Provider (`claude`, `codex`, `gemini`; default `claude`), `[ ADD ]` and `[ CANCEL ]`. ADD runs `orc project add <path> [--name=<name>]` and then `orc --project=<id> init --provider=<provider>` (which records the provider and starts no coordinator); success closes the dialog and, once the project watcher reports the project, shows it.

The new-agent dialog (`lib/cockpit2/newAgentDialog.ts`), titled `[ NEW AGENT · <PROJECT> ]`, opened by `[+ NEW AGENT]` (`openNewAgent(projectId)`): Provider (default the project's `worker_pool.provider`, else `default_provider`, else `claude`), Variant (`fresh session` or `custom agent`), Agent (only for a custom agent: the checkout's `.claude/agents/*.md`, named by their frontmatter `name`, else the file name; with none the row reads `no custom agents in .claude/agents` and START is refused), `[ START ]` and `[ CANCEL ]`.

## Agent sessions

An agent session started from the new-agent dialog runs outside the coordinator: it is not a registered agent (no orc hooks, bootstrap, settings file or session secret) and only the cockpit knows it. Like a shell tab it is a session (`agent-<project>-<N>`) on the cockpit's private `orc-explorer` tmux server in the project's checkout (`target_repo_root`), without `ORC_*` or a parent provider session's variables (`lib/providerChildEnv.ts`), running the provider's interactive CLI as the user would (`claude`, `codex`, `gemini`; a CLI that fails keeps its exit status on screen until a key). Its tab (`agent:N`, the first free number) is labelled `<provider> N` for a fresh session or `<agent> · <provider>` for a custom agent, types like the master (no view mode), and its pane box reads `[ CLAUDE 1 ] <project> · fresh session` or `[ CRITIC ] <project> · claude`. A custom agent's prompt (its definition's body) is its first message, sent as a worker's bootstrap is: once the pane shows something, is not asking whether to trust the folder (the user answers that in the tab) and has not changed for 1.5 s, as a bracketed paste and then Enter (`tmux load-buffer`/`paste-buffer -p`/`send-keys`); a session not ready within two minutes gets no prompt and the tab bar says so. Closing the tab (`×`) kills the session, and the session ending closes its tab. The tabs and what each runs (`agentTabs` in `view-state.json`: provider, custom agent, `openedAt`) are kept across cockpit restarts, so a session still running is shown again. The Agents card lists them, flagged `[LOCAL]` (Layout).
