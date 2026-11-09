import { stripVTControlCharacters } from 'node:util';

/**
 * Height budget for the `orc watch` frame.
 *
 * Ink clears the whole terminal and repaints on every render once the frame is
 * at least as tall as the terminal, which reads as constant flicker. The budget
 * keeps the frame strictly shorter than `rows`: fixed sections (header, failure
 * alert, worker slots) come first, then the lists (runs, events, scouts) share
 * what is left, each truncated with a "+N more" line.
 */

/** Worker slot detail: `full` shows the sprite, `compact` drops it, `minimal` also collapses phases to one row. */
export type SlotDetail = 'full' | 'compact' | 'minimal';

/** Outer width of one worker slot (flex basis 36 plus 1 right margin): slots wrap at this width. */
export const SLOT_OUTER_WIDTH = 37;

/** The event feed never shows more than this many events. */
export const EVENT_FEED_LIMIT = 10;

export interface LayoutSlotInput {
  /** Phase rows in full/compact detail (phases plus the activity line, or 1/0 for the run-state line). */
  phaseLines: number;
}

export interface LayoutInput {
  rows: number | undefined;
  columns: number | undefined;
  bannerLines: number;
  bannerWidth: number;
  spriteLines: number;
  hasFailures: boolean;
  slots: LayoutSlotInput[];
  scoutCount: number;
  runCount: number;
  eventCount: number;
  hasEventError: boolean;
}

export interface Layout {
  showBanner: boolean;
  slotDetail: SlotDetail;
  /** Item lines each list may use, its "+N more" line included. */
  maxScoutLines: number;
  maxRunLines: number;
  maxEventLines: number;
}

/** Lines one worker slot takes at a given detail, border included. */
export function slotHeight(slot: LayoutSlotInput, detail: SlotDetail, spriteLines: number): number {
  // border (2) + id + provider + task + two age lines
  const base = 7;
  if (detail === 'minimal') return base + 1;
  const phases = slot.phaseLines;
  return base + phases + (detail === 'full' ? spriteLines : 0);
}

function gridHeight(input: LayoutInput, detail: SlotDetail): number {
  // title + marginBottom
  if (input.slots.length === 0) return 3;
  const perRow = Math.max(1, Math.floor((input.columns ?? 80) / SLOT_OUTER_WIDTH));
  let total = 2;
  for (let start = 0; start < input.slots.length; start += perRow) {
    const row = input.slots.slice(start, start + perRow);
    total += Math.max(...row.map(slot => slotHeight(slot, detail, input.spriteLines))) + 1;
  }
  return total;
}

function headerHeight(input: LayoutInput, showBanner: boolean): number {
  // identity + counts + marginBottom
  return (showBanner ? input.bannerLines : 0) + 3;
}

/** Item lines a list wants: one per item, or one "(none)" line. */
function wanted(count: number): number {
  return Math.max(1, count);
}

export function computeLayout(input: LayoutInput): Layout {
  const bannerFits = input.columns == null || input.columns >= input.bannerWidth;
  const eventCount = Math.min(input.eventCount, EVENT_FEED_LIMIT);

  if (input.rows == null || input.rows <= 0) {
    return {
      showBanner: bannerFits,
      slotDetail: 'full',
      maxScoutLines: Infinity,
      maxRunLines: Infinity,
      maxEventLines: Infinity,
    };
  }

  // Frame must stay strictly below `rows`.
  const available = input.rows - 1;
  // Each list keeps its title, one item line and its margin.
  const listChrome = (1 + 1) + (1 + 1) + (1 + (input.hasEventError ? 1 : 0));
  const listMinimum = listChrome + 3;

  const candidates = (['full', 'compact', 'minimal'] as const).map(slotDetail => ({ showBanner: bannerFits, slotDetail }));
  if (bannerFits) candidates.push({ showBanner: false, slotDetail: 'minimal' });

  const fixedHeight = (c: { showBanner: boolean; slotDetail: SlotDetail }) =>
    headerHeight(input, c.showBanner) + (input.hasFailures ? 1 : 0) + gridHeight(input, c.slotDetail);

  const chosen = candidates.find(c => fixedHeight(c) + listMinimum <= available) ?? candidates[candidates.length - 1];
  let spare = Math.max(0, available - fixedHeight(chosen) - listMinimum);

  // Runs first (they mirror the workers), then events, then scouts.
  const grant = (count: number) => {
    const extra = Math.min(wanted(count) - 1, spare);
    spare -= extra;
    return 1 + extra;
  };
  const maxRunLines = grant(input.runCount);
  const maxEventLines = grant(eventCount);
  const maxScoutLines = grant(input.scoutCount);

  return { ...chosen, maxScoutLines, maxRunLines, maxEventLines };
}

/** Items to show within `maxLines`, and how many are hidden behind a "+N more" line. */
export function fitList<T>(items: readonly T[], maxLines: number): { shown: T[]; hidden: number } {
  if (items.length <= maxLines) return { shown: [...items], hidden: 0 };
  const keep = Math.max(0, maxLines - 1);
  return { shown: items.slice(0, keep), hidden: items.length - keep };
}

/** Visible line count and width of a rendered (possibly coloured) block of text. */
export function measureBlock(text: string): { lines: number; width: number } {
  const lines = text.split('\n');
  const width = Math.max(0, ...lines.map(line => stripVTControlCharacters(line).length));
  return { lines: lines.length, width };
}

