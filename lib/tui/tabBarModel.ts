import { stringWidth } from '../cellWidth.ts';
import { ATTENTION_BADGE, fitText, type AttentionKind } from './sidebar.ts';
import type { TuiProjectView } from './status.ts';

/**
 * The cockpit tab bar's view model: the active project's tabs (the master tab
 * first, then the agent tabs in opening order) as square-bordered tabs in three rows,
 * the active one open towards the slot, an agent needing attention with its
 * badge, and a window around the active tab when they do not all fit. Pure
 * data, so the view can compare two models and skip a render when nothing
 * changed, and hit-test a click by column. Widths and columns are display
 * widths (lib/cellWidth.ts), so wide-character names lay out correctly.
 */

/** The cockpit's tab state (lib/cockpitTabs.ts), structurally. */
export interface TabBarState {
  activeProject: string | null;
  projects: { projectId: string; tabs: string[]; active: string | null }[];
}

export interface TabBarTab {
  /** The agent id; null for the master tab. */
  agentId: string | null;
  /** Its number, as the tab keys select it (master 1). */
  number: number;
  label: string;
  active: boolean;
  /** Shown as a badge; only agent tabs carry one. */
  attention: AttentionKind | null;
  /** Agent tabs have a close marker; the master tab has none. */
  closable: boolean;
}

export interface TabBarModel {
  tabs: TabBarTab[];
  /** Shown instead of tabs: no project is open, or the tab state cannot be read. */
  notice: string | null;
}

export const NO_PROJECT_NOTICE = 'No project is open; run orc start-session in one.';
export const CLOSE_MARKER = '×';

/** The agents of `projectId` needing attention, by agent id, from the client's status view (its master left out). */
export function tabAttention(views: TuiProjectView[], projectId: string | null): Map<string, AttentionKind> {
  const view = views.find(candidate => candidate.project_id === projectId);
  const attention = new Map<string, AttentionKind>();
  for (const slot of view?.status?.worker_capacity.slots ?? []) {
    if (slot.attention && slot.role !== 'master') attention.set(slot.agent_id, slot.attention.kind);
  }
  return attention;
}

/** The active project's tabs; `attention` badges its agent tabs. */
export function buildTabBarModel(state: TabBarState, attention: Map<string, AttentionKind> = new Map()): TabBarModel {
  const project = state.projects.find(candidate => candidate.projectId === state.activeProject);
  if (!project) return { tabs: [], notice: NO_PROJECT_NOTICE };
  const tabs = [null, ...project.tabs].map((agentId, index): TabBarTab => ({
    agentId,
    number: index + 1,
    label: agentId ?? 'master',
    active: agentId === project.active,
    attention: agentId === null ? null : attention.get(agentId) ?? null,
    closable: agentId !== null,
  }));
  return { tabs, notice: null };
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** A shown tab: its first column and width (borders included), its text, and its close marker's column. */
export interface TabBarCell {
  index: number;
  x: number;
  width: number;
  /** ` 2 name`, cut to fit; the badge and the close marker follow it. */
  text: string;
  badge: string;
  /** Column of the close marker; null for the master tab. */
  closeX: number | null;
}

export interface TabBarLayout {
  cells: TabBarCell[];
  /** Tabs hidden left and right of the shown ones (`‹ N`, `N ›`). */
  hiddenLeft: number;
  hiddenRight: number;
  /** The markers as drawn (empty without hidden tabs). */
  leftMarker: string;
  rightMarker: string;
}

const tabText = (tab: TabBarTab) => ` ${tab.number} ${tab.label}`;
/** ` ! KIND`: the exclamation mark keeps the badge readable without colour. */
const tabBadge = (tab: TabBarTab) => (tab.attention ? ` ! ${ATTENTION_BADGE[tab.attention]}` : '');
const tabTail = (tab: TabBarTab) => `${tab.closable ? ` ${CLOSE_MARKER}` : ''} `;
/** A tab's width: its borders, its text, badge, close marker and padding. */
export const tabWidth = (tab: TabBarTab) => 2 + stringWidth(tabText(tab)) + stringWidth(tabBadge(tab)) + stringWidth(tabTail(tab));

/** Columns between two tabs. */
export const TAB_GAP = 1;

const leftMarkerOf = (hidden: number) => (hidden > 0 ? `‹ ${hidden} ` : '');
const rightMarkerOf = (hidden: number) => (hidden > 0 ? ` ${hidden} ›` : '');

/**
 * Which tabs fit `columns`: all of them, or a run around the active tab
 * (grown right, then left, while it fits) with markers counting the hidden
 * ones. The active tab is always shown, its name cut when even it alone does
 * not fit.
 */
export function layoutTabBar(model: TabBarModel, columns: number): TabBarLayout {
  const { tabs } = model;
  const widths = tabs.map(tabWidth);
  const total = (start: number, end: number) => widths.slice(start, end).reduce((sum, width) => sum + width, 0)
    + TAB_GAP * Math.max(0, end - start - 1) + stringWidth(leftMarkerOf(start)) + stringWidth(rightMarkerOf(tabs.length - end));
  const fits = (start: number, end: number) => total(start, end) <= columns;

  let start = 0;
  let end = tabs.length;
  if (!fits(start, end)) {
    const active = Math.max(0, tabs.findIndex(tab => tab.active));
    start = active;
    end = Math.min(tabs.length, active + 1);
    for (let grew = true; grew;) {
      grew = false;
      if (end < tabs.length && fits(start, end + 1)) {
        end += 1;
        grew = true;
      }
      if (start > 0 && fits(start - 1, end)) {
        start -= 1;
        grew = true;
      }
    }
  }

  const leftMarker = leftMarkerOf(start);
  const rightMarker = rightMarkerOf(tabs.length - end);
  // Below zero when even the active tab alone does not fit: its text is cut, then its badge.
  const spare = columns - total(start, end);
  const cells: TabBarCell[] = [];
  let x = stringWidth(leftMarker);
  for (let index = start; index < end; index += 1) {
    const tab = tabs[index];
    const tail = tabTail(tab);
    let text = tabText(tab);
    let badge = tabBadge(tab);
    if (spare < 0) {
      const room = Math.max(0, columns - stringWidth(leftMarker) - stringWidth(rightMarker) - 2 - stringWidth(tail));
      // The badge says the agent needs a human: the name gives way first, down to its number.
      text = fitText(text, Math.min(stringWidth(text), Math.max(4, room - stringWidth(badge))));
      badge = fitText(badge, Math.max(0, room - stringWidth(text)));
    }
    const width = 2 + stringWidth(text) + stringWidth(badge) + stringWidth(tail);
    cells.push({ index, x, width, text, badge, closeX: tab.closable ? x + 1 + stringWidth(text) + stringWidth(badge) + 1 : null });
    x += width + TAB_GAP;
  }
  return { cells, hiddenLeft: start, hiddenRight: tabs.length - end, leftMarker, rightMarker };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type TabBarSegmentKind = 'border' | 'text' | 'badge' | 'close' | 'marker' | 'rule' | 'notice' | 'error';

/** A run of one style in a row; `tab` indexes `model.tabs`. */
export interface TabBarSegment {
  kind: TabBarSegmentKind;
  text: string;
  tab?: number;
}

/**
 * The bar's three rows: the tabs' top borders; their text between side
 * borders (and the overflow markers); their bottom edge on the rule above
 * the slot, open under the active tab. `error` (what the last click's action
 * reported) takes the bottom row; a notice takes the middle one.
 */
export function tabBarRows(model: TabBarModel, layout: TabBarLayout, columns: number, error: string | null = null): TabBarSegment[][] {
  const width = Math.max(1, columns);
  const bottomError: TabBarSegment[] | null = error ? [{ kind: 'error', text: fitText(error, width) }] : null;
  if (model.notice) {
    return [[], [{ kind: 'notice', text: fitText(model.notice, width) }], bottomError ?? [{ kind: 'rule', text: '─'.repeat(width) }]];
  }
  const top: TabBarSegment[] = [];
  const middle: TabBarSegment[] = [];
  const bottom: TabBarSegment[] = [];
  if (layout.leftMarker) {
    top.push({ kind: 'border', text: ' '.repeat(stringWidth(layout.leftMarker)) });
    middle.push({ kind: 'marker', text: layout.leftMarker });
    bottom.push({ kind: 'rule', text: '─'.repeat(stringWidth(layout.leftMarker)) });
  }
  for (const [position, cell] of layout.cells.entries()) {
    const tab = model.tabs[cell.index];
    const inner = cell.width - 2;
    if (position > 0) {
      top.push({ kind: 'border', text: ' '.repeat(TAB_GAP) });
      middle.push({ kind: 'border', text: ' '.repeat(TAB_GAP) });
      bottom.push({ kind: 'rule', text: '─'.repeat(TAB_GAP) });
    }
    top.push({ kind: 'border', text: `┌${'─'.repeat(inner)}┐`, tab: cell.index });
    middle.push({ kind: 'border', text: '│', tab: cell.index });
    middle.push({ kind: 'text', text: cell.text, tab: cell.index });
    if (cell.badge) middle.push({ kind: 'badge', text: cell.badge, tab: cell.index });
    if (tab.closable) {
      middle.push({ kind: 'text', text: ' ', tab: cell.index });
      middle.push({ kind: 'close', text: CLOSE_MARKER, tab: cell.index });
    }
    middle.push({ kind: 'text', text: ' ', tab: cell.index });
    middle.push({ kind: 'border', text: '│', tab: cell.index });
    bottom.push({ kind: 'border', text: tab.active ? `┘${' '.repeat(inner)}└` : `┴${'─'.repeat(inner)}┴`, tab: cell.index });
  }
  if (layout.rightMarker) middle.push({ kind: 'marker', text: layout.rightMarker });
  const used = stringWidth(layout.leftMarker) + layout.cells.reduce((sum, cell) => sum + cell.width, 0) + TAB_GAP * Math.max(0, layout.cells.length - 1);
  if (width > used) bottom.push({ kind: 'rule', text: '─'.repeat(width - used) });
  return [top, middle, bottomError ?? bottom];
}

/** The rows as plain text (tests, and anything without colour). */
export function tabBarText(rows: TabBarSegment[][]): string[] {
  return rows.map(row => row.map(segment => segment.text).join(''));
}

// ── Clicks ───────────────────────────────────────────────────────────────────

/** What a click at column `x` (any row) does: show a tab, close an agent tab, or nothing. */
export type TabBarClick = { kind: 'select'; tab: TabBarTab } | { kind: 'close'; tab: TabBarTab } | null;

export function tabBarClickTarget(model: TabBarModel, layout: TabBarLayout, x: number): TabBarClick {
  if (model.notice) return null;
  const cell = layout.cells.find(candidate => x >= candidate.x && x < candidate.x + candidate.width);
  if (!cell) return null;
  const tab = model.tabs[cell.index];
  // The close marker and the cell right of it, so a click a little off still closes.
  if (cell.closeX !== null && (x === cell.closeX || x === cell.closeX + 1)) return { kind: 'close', tab };
  return { kind: 'select', tab };
}
