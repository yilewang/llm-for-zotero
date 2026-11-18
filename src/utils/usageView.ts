/**
 * The Usage view's arithmetic and copy, with no DOM in sight.
 *
 * Zotero's preferences window is a Gecko/XUL chrome document: there is no CDN,
 * so there is no chart library, so every pixel of the heatmap and the token
 * chart is a hand-placed SVG node. That would normally make the charts
 * untestable. It does not here, because the geometry is decided in this file
 * — which day sits in which column, how tall a bar's library segment is,
 * where the axis ticks land — and the renderer in
 * `src/modules/preferences/usagePanel.ts` only turns those numbers into nodes.
 *
 * Every string a user reads is also built here, for the same reason: the
 * honesty rules (never printing "0 tokens" for a turn whose provider reported
 * nothing) are assertions about copy, and copy that lives in a render function
 * cannot be asserted. All of it goes through `t()`, so the tab speaks the same
 * language as the rest of the preferences window.
 *
 * The view reports TOKENS, never money. There is no cost estimate and no
 * pricing anywhere in this feature: a dollar figure would be a guess about a
 * user's bill built from a price table this plugin cannot keep correct.
 */

import { t } from "./i18n";
import type { UsageDailyTokens, UsageHeatmapDay } from "./usageStats";
import type { StoredUsageEvent } from "./usageStore";

/**
 * `t()` plus `{placeholder}` substitution: the one way copy is built here.
 *
 * Numbers are formatted first and passed in already rendered, so a translation
 * never has to carry an English plural artefact — "1 question" and
 * "3 questions" are two English keys that map to the one Chinese sentence.
 */
export function usageText(
  template: string,
  values: Record<string, string | number> = {},
): string {
  let output = t(template);
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, String(value));
  }
  return output;
}

/** Paper chat's identity colour on a light pane. */
export const USAGE_PAPER_COLOR = "#8A5A3C";
/** Library chat's identity colour on a light pane. */
export const USAGE_LIBRARY_COLOR = "#C79463";

/** Five ramp stops, least to most active, on a light pane. */
export const USAGE_HEATMAP_RAMP: readonly string[] = [
  "#EAF3DE",
  "#C0DD97",
  "#97C459",
  "#639922",
  "#3B6D11",
];

/**
 * The dark ramp, least to most active.
 *
 * It runs dim-to-vivid rather than being the light ramp turned around: on a
 * dark pane the light ramp's near-white first stop makes a day with one
 * question the brightest thing on the grid, which reads as the opposite of
 * what it means. Nothing near white is ever a data colour here.
 */
export const USAGE_HEATMAP_RAMP_DARK: readonly string[] = [
  "#1B2A12",
  "#2B4A16",
  "#3E6B1C",
  "#5F9A26",
  "#8FCB4D",
];

export type UsageColorScheme = "light" | "dark";

/**
 * The dark pane's empty-day cell.
 *
 * It is NOT the shared subtle surface: `--llm-usage-subtle` is a desaturated
 * grey mixed towards the field colour, and on a dark pane it comes out LIGHTER
 * than `#1B2A12`, the darkest ramp stop. That made "no activity" read brighter
 * than "a little activity" and the legend run More → Less → More. This tone is
 * darker than ramp stop 1 and near-neutral, so it stays visibly outside the
 * green ramp — the same relationship GitHub's dark heatmap uses. The light
 * pane never had the problem and keeps the shared surface.
 */
export const USAGE_HEATMAP_EMPTY_DARK = "#1A1D1A";

/** Metric cards, list tracks, and the LIGHT pane's empty heatmap cells. */
export const USAGE_SUBTLE_SURFACE = "var(--llm-usage-subtle)";

export type UsagePalette = {
  paper: string;
  library: string;
  ramp: readonly string[];
  /** The fill for a day with no activity, which is no ramp stop at all. */
  emptyCell: string;
};

export const USAGE_LIGHT_PALETTE: UsagePalette = {
  paper: USAGE_PAPER_COLOR,
  library: USAGE_LIBRARY_COLOR,
  ramp: USAGE_HEATMAP_RAMP,
  emptyCell: USAGE_SUBTLE_SURFACE,
};

/**
 * The dark pane keeps the two-browns identity but lifts both out of the
 * background: #8A5A3C is so close to the pane that a stacked bar reads as one
 * colour and the paper/library split disappears.
 */
export const USAGE_DARK_PALETTE: UsagePalette = {
  paper: "#B07E57",
  library: "#E0B487",
  ramp: USAGE_HEATMAP_RAMP_DARK,
  emptyCell: USAGE_HEATMAP_EMPTY_DARK,
};

export function resolveUsagePalette(scheme: UsageColorScheme): UsagePalette {
  return scheme === "dark" ? USAGE_DARK_PALETTE : USAGE_LIGHT_PALETTE;
}

/** A day with no activity is not the lightest ramp stop; it is no stop. */
export const USAGE_HEATMAP_EMPTY_LEVEL = 0;

/** Cell and gutter geometry the spec fixes; the renderer reads them from here. */
export const USAGE_HEATMAP_CELL_SIZE = 8;
export const USAGE_HEATMAP_CELL_GAP = 2;
export const USAGE_HEATMAP_CELL_RADIUS = 2;
export const USAGE_HEATMAP_ROWS = 7;

export const USAGE_CHART_HEIGHT = 120;
export const USAGE_CHART_BAR_RATIO = 0.7;
export const USAGE_CHART_BAR_RADIUS = 2;
export const USAGE_CHART_Y_TICKS = 4;
export const USAGE_CHART_MAX_X_TICKS = 7;

export type UsageHeatmapMetric = "questions" | "papers";

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Rows carrying a weekday label, Sunday-first like the grid itself. */
const WEEKDAY_LABEL_ROWS: ReadonlyArray<{ row: number; label: string }> = [
  { row: 1, label: "Mon" },
  { row: 3, label: "Wed" },
  { row: 5, label: "Fri" },
];

/** Columns that must separate two month labels before the second is drawn. */
const MONTH_LABEL_MIN_GAP = 3;

/**
 * Parse `YYYY-MM-DD` at local noon.
 *
 * Noon, not midnight: the ledger stores local calendar days, and a midnight
 * Date in a zone that springs forward at 00:00 lands on the previous day.
 */
function parseLocalDate(localDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    String(localDate || "").trim(),
  );
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
  );
  return Number.isFinite(date.getTime()) ? date : null;
}

function toFiniteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Drop a trailing `.0` so "1.0k" reads as "1k". */
function trimDecimal(value: string): string {
  return value.replace(/\.0$/, "");
}

function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Counts are whole things: questions, papers, conversations. */
export function formatUsageCount(value: number): string {
  const rounded = Math.round(toFiniteNumber(value));
  const sign = rounded < 0 ? "-" : "";
  return sign + groupThousands(String(Math.abs(rounded)));
}

/**
 * Tokens, abbreviated. Millions carry one decimal as the spec requires, and
 * thousands do too so a chart label and a card never disagree about a number.
 */
export function formatUsageTokens(value: number): string {
  const amount = Math.max(0, Math.round(toFiniteNumber(value)));
  if (amount >= 1_000_000)
    return `${trimDecimal((amount / 1_000_000).toFixed(1))}M`;
  if (amount >= 1000) return `${trimDecimal((amount / 1000).toFixed(1))}k`;
  return formatUsageCount(amount);
}

/** Axis ticks use the same abbreviation; they are just never grouped. */
export function formatUsageAxisTokens(value: number): string {
  return formatUsageTokens(value);
}

/** `2026-03-12` -> `12 Mar 2026`. */
export function formatUsageDateLabel(localDate: string): string {
  const date = parseLocalDate(localDate);
  if (!date) return String(localDate || "");
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

/** `2026-03-12` -> `12 Mar`, for axis ticks that repeat within one year. */
export function formatUsageShortDateLabel(localDate: string): string {
  const date = parseLocalDate(localDate);
  if (!date) return String(localDate || "");
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return Math.round(toFiniteNumber(count)) === 1 ? singular : pluralForm;
}

/**
 * Which ramp stop a value lands on, 1..5, against that metric's own maximum.
 *
 * Zero is level 0 and stays the panel's empty-cell surface: a day with no
 * questions must not look like a day with a few.
 */
export function usageHeatmapLevel(value: number, max: number): number {
  const amount = toFiniteNumber(value);
  const ceiling = toFiniteNumber(max);
  if (amount <= 0 || ceiling <= 0) return USAGE_HEATMAP_EMPTY_LEVEL;
  const level = Math.ceil((amount / ceiling) * USAGE_HEATMAP_RAMP.length);
  return Math.min(USAGE_HEATMAP_RAMP.length, Math.max(1, level));
}

export type UsageHeatmapCellModel = {
  localDate: string;
  /** Week index from the Sunday on or before the window's first day. */
  column: number;
  /** Weekday index, 0 = Sunday. */
  row: number;
  value: number;
  level: number;
};

export type UsageHeatmapGridModel = {
  columns: number;
  rows: number;
  max: number;
  cells: UsageHeatmapCellModel[];
  monthLabels: Array<{ column: number; label: string }>;
  weekdayLabels: ReadonlyArray<{ row: number; label: string }>;
};

function heatmapValue(
  day: UsageHeatmapDay,
  metric: UsageHeatmapMetric,
): number {
  return metric === "papers"
    ? toFiniteNumber(day.distinctPapers)
    : toFiniteNumber(day.questions);
}

/**
 * Lay the window's days out as weeks-across, weekdays-down.
 *
 * The grid is anchored on the Sunday on or before the first day so a window
 * that starts mid-week leaves the right number of blank rows at the top of its
 * first column, exactly as the mockup shows.
 */
export function buildUsageHeatmapGrid(
  days: readonly UsageHeatmapDay[],
  metric: UsageHeatmapMetric,
): UsageHeatmapGridModel {
  const parsed = days
    .map((day) => ({ day, date: parseLocalDate(day.localDate) }))
    .filter((entry): entry is { day: UsageHeatmapDay; date: Date } =>
      Boolean(entry.date),
    );
  if (!parsed.length) {
    return {
      columns: 0,
      rows: USAGE_HEATMAP_ROWS,
      max: 0,
      cells: [],
      monthLabels: [],
      weekdayLabels: WEEKDAY_LABEL_ROWS,
    };
  }
  const first = parsed[0]!.date;
  const anchor = new Date(
    first.getFullYear(),
    first.getMonth(),
    first.getDate() - first.getDay(),
    12,
  );
  const max = parsed.reduce(
    (highest, entry) => Math.max(highest, heatmapValue(entry.day, metric)),
    0,
  );
  const cells: UsageHeatmapCellModel[] = [];
  const firstDayOfColumn = new Map<number, Date>();
  for (const entry of parsed) {
    // Calendar days, not milliseconds: a DST boundary makes a day 23 or 25
    // hours long and would otherwise shift a whole column.
    const offset = Math.round(
      (entry.date.getTime() - anchor.getTime()) / 86_400_000,
    );
    const column = Math.floor(offset / 7);
    const row = entry.date.getDay();
    const value = heatmapValue(entry.day, metric);
    cells.push({
      localDate: entry.day.localDate,
      column,
      row,
      value,
      level: usageHeatmapLevel(value, max),
    });
    if (!firstDayOfColumn.has(column)) firstDayOfColumn.set(column, entry.date);
  }
  const columns =
    cells.reduce((widest, cell) => Math.max(widest, cell.column), 0) + 1;
  const monthLabels: Array<{ column: number; label: string }> = [];
  let previousMonth: number | null = null;
  let lastLabelledColumn = -MONTH_LABEL_MIN_GAP;
  for (let column = 0; column < columns; column += 1) {
    const date = firstDayOfColumn.get(column);
    if (!date) continue;
    const month = date.getMonth();
    const startsHere =
      previousMonth === null ? date.getDate() <= 7 : month !== previousMonth;
    previousMonth = month;
    if (!startsHere) continue;
    if (column - lastLabelledColumn < MONTH_LABEL_MIN_GAP) continue;
    monthLabels.push({ column, label: MONTH_NAMES[month]! });
    lastLabelledColumn = column;
  }
  return {
    columns,
    rows: USAGE_HEATMAP_ROWS,
    max,
    cells,
    monthLabels,
    weekdayLabels: WEEKDAY_LABEL_ROWS,
  };
}

/** The right-aligned line under the heatmap, for whichever metric is shown. */
export function describeUsageHeatmapSummary(
  heatmap: {
    totalQuestions: number;
    activeDays: number;
    distinctPapers: number;
  },
  metric: UsageHeatmapMetric,
): string {
  const activeDays = toFiniteNumber(heatmap.activeDays);
  const value = toFiniteNumber(
    metric === "papers" ? heatmap.distinctPapers : heatmap.totalQuestions,
  );
  // Both halves of the sentence are pluralised in English and neither is in
  // Chinese, so every arity is its own key rather than a phrase glued
  // together from fragments.
  const template =
    metric === "papers"
      ? plural(
          value,
          plural(
            activeDays,
            "{count} distinct paper across {days} active day",
            "{count} distinct paper across {days} active days",
          ),
          plural(
            activeDays,
            "{count} distinct papers across {days} active day",
            "{count} distinct papers across {days} active days",
          ),
        )
      : plural(
          value,
          plural(
            activeDays,
            "{count} question across {days} active day",
            "{count} question across {days} active days",
          ),
          plural(
            activeDays,
            "{count} questions across {days} active day",
            "{count} questions across {days} active days",
          ),
        );
  return usageText(template, {
    count: formatUsageCount(value),
    days: formatUsageCount(activeDays),
  });
}

/**
 * `2026-09-18` -> `Fri, 18 Sep 2026`, in the window's own locale.
 *
 * The popover's first line is the one place a whole date is spelled out, and a
 * date is formatting, not copy: it goes through the runtime's locale data
 * rather than through `t()`. A locale the runtime cannot resolve falls back to
 * the panel's own label rather than throwing the popover away.
 */
export function formatUsageFullDateLabel(
  localDate: string,
  locale?: string,
): string {
  const date = parseLocalDate(localDate);
  if (!date) return String(localDate || "");
  try {
    return date.toLocaleDateString(locale || undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return formatUsageDateLabel(localDate);
  }
}

/** Everything the hover popover needs about one day of the grid. */
export type UsageHeatmapPopoverDay = {
  localDate: string;
  questions: number;
  distinctPapers: number;
  totalTokens: number;
  providerRows: number;
  unreportedRows: number;
  estimateRows: number;
};

/**
 * The two or three lines the heatmap's hover popover shows.
 *
 * Line three obeys the same honesty rule as the Tokens card: a day whose rows
 * were never measured says so instead of printing "0 tokens", and a day
 * rebuilt from chat history says its number is an estimate. A day with no rows
 * at all makes no claim about tokens whatsoever.
 */
export function describeUsageHeatmapPopover(
  day: UsageHeatmapPopoverDay,
  metric: UsageHeatmapMetric,
  options: { locale?: string } = {},
): string[] {
  const date = formatUsageFullDateLabel(day.localDate, options.locale);
  const provider = Math.max(0, Math.floor(toFiniteNumber(day.providerRows)));
  const unreported = Math.max(
    0,
    Math.floor(toFiniteNumber(day.unreportedRows)),
  );
  const estimated = Math.max(0, Math.floor(toFiniteNumber(day.estimateRows)));
  if (provider + unreported + estimated <= 0) {
    return [date, t("No activity")];
  }
  const value = toFiniteNumber(
    metric === "papers" ? day.distinctPapers : day.questions,
  );
  const activity = usageText(
    metric === "papers"
      ? plural(value, "{count} paper", "{count} papers")
      : plural(value, "{count} question", "{count} questions"),
    { count: formatUsageCount(value) },
  );
  if (estimated > 0) {
    return [
      date,
      activity,
      usageText("{tokens} tokens · estimate", {
        tokens: formatUsageTokens(day.totalTokens),
      }),
    ];
  }
  if (provider <= 0) {
    // Every row that day was unreported: the tokens are unknown, not zero.
    return [date, activity, t("Tokens not reported")];
  }
  return [
    date,
    activity,
    usageText("{tokens} tokens", {
      tokens: formatUsageTokens(day.totalTokens),
    }),
  ];
}

/** How far the popover sits from the pointer, on both axes. */
export const USAGE_POPOVER_OFFSET = 12;

export type UsagePopoverPlacement = {
  /** Panel-relative offsets, ready for `left`/`top`. */
  left: number;
  top: number;
  flippedX: boolean;
  flippedY: boolean;
};

/**
 * Where the popover goes, in panel-relative pixels.
 *
 * It trails the pointer down and to the right, and flips to the other side of
 * it near the panel's right or bottom edge so the card is never clipped. A
 * container too small for either side keeps the card at the edge rather than
 * pushing it out of view.
 */
export function placeUsagePopover(input: {
  pointerX: number;
  pointerY: number;
  popoverWidth: number;
  popoverHeight: number;
  containerWidth: number;
  containerHeight: number;
  offset?: number;
}): UsagePopoverPlacement {
  const offset = toFiniteNumber(input.offset ?? USAGE_POPOVER_OFFSET);
  const pointerX = toFiniteNumber(input.pointerX);
  const pointerY = toFiniteNumber(input.pointerY);
  const width = Math.max(0, toFiniteNumber(input.popoverWidth));
  const height = Math.max(0, toFiniteNumber(input.popoverHeight));
  const containerWidth = Math.max(0, toFiniteNumber(input.containerWidth));
  const containerHeight = Math.max(0, toFiniteNumber(input.containerHeight));
  const flippedX = pointerX + offset + width > containerWidth;
  const flippedY = pointerY + offset + height > containerHeight;
  const left = flippedX ? pointerX - offset - width : pointerX + offset;
  const top = flippedY ? pointerY - offset - height : pointerY + offset;
  return {
    left: Math.max(0, Math.round(left)),
    top: Math.max(0, Math.round(top)),
    flippedX,
    flippedY,
  };
}

/** Heatmap windows, shortest first; a year is only drawn once it means something. */
const HEATMAP_WINDOWS = [56, 91, 182, 365];

/**
 * How many days the heatmap should span.
 *
 * A user two weeks into the plugin must not be shown a year of grey: the
 * window grows in steps as their history does, and only reaches the spec's
 * 53 columns once there is roughly that much history to fill them.
 */
export function resolveUsageHeatmapDays(
  firstLocalDate: string | null,
  now: number = Date.now(),
): number {
  const first = firstLocalDate ? parseLocalDate(firstLocalDate) : null;
  if (!first) return HEATMAP_WINDOWS[0]!;
  const today = new Date(now);
  const anchor = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    12,
  );
  const span =
    Math.round((anchor.getTime() - first.getTime()) / 86_400_000) + 1;
  for (const window of HEATMAP_WINDOWS) {
    if (span <= window) return window;
  }
  return HEATMAP_WINDOWS[HEATMAP_WINDOWS.length - 1]!;
}

export type UsageChartSegment = {
  y: number;
  height: number;
  color: string;
  /** True for the topmost segment of a bar, which carries the rounded cap. */
  roundTop: boolean;
};

export type UsageChartBar = {
  localDate: string;
  x: number;
  width: number;
  segments: UsageChartSegment[];
};

export type UsageChartModel = {
  width: number;
  height: number;
  plot: { x: number; y: number; width: number; height: number };
  max: number;
  bars: UsageChartBar[];
  yTicks: Array<{ value: number; y: number; label: string }>;
  xTicks: Array<{ x: number; label: string }>;
};

const CHART_LEFT_GUTTER = 38;
const CHART_BOTTOM_GUTTER = 16;
const CHART_TOP_PADDING = 4;

/** The next 1/2/2.5/5 × 10^n at or above `value`, so ticks read as round numbers. */
function niceStep(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    const candidate = multiple * magnitude;
    if (candidate >= value - candidate * 1e-9) return candidate;
  }
  return magnitude * 10;
}

/**
 * The stacked daily token chart, as geometry.
 *
 * Paper tokens sit on the baseline and library tokens stack on top, matching
 * the order the model table uses, and only the bar's topmost segment is capped
 * so the join between the two colours stays square.
 */
export function buildUsageTokenChartModel(
  days: readonly UsageDailyTokens[],
  options: { width: number; height?: number; palette?: UsagePalette },
): UsageChartModel {
  const palette = options.palette || USAGE_LIGHT_PALETTE;
  const width = Math.max(120, toFiniteNumber(options.width));
  const height = Math.max(
    60,
    toFiniteNumber(options.height ?? USAGE_CHART_HEIGHT),
  );
  const plot = {
    x: CHART_LEFT_GUTTER,
    y: CHART_TOP_PADDING,
    width: Math.max(1, width - CHART_LEFT_GUTTER),
    height: Math.max(1, height - CHART_TOP_PADDING - CHART_BOTTOM_GUTTER),
  };
  const max = days.reduce(
    (highest, day) => Math.max(highest, toFiniteNumber(day.totalTokens)),
    0,
  );
  const intervals = USAGE_CHART_Y_TICKS - 1;
  const step = niceStep(max > 0 ? max / intervals : 1 / intervals);
  const top = step * intervals;
  const yTicks = Array.from({ length: USAGE_CHART_Y_TICKS }, (_, index) => {
    const value = step * index;
    return {
      value,
      y: plot.y + plot.height - (value / top) * plot.height,
      label: formatUsageAxisTokens(value),
    };
  });
  const slot = days.length ? plot.width / days.length : plot.width;
  const barWidth = slot * USAGE_CHART_BAR_RATIO;
  const bars: UsageChartBar[] = days.map((day, index) => {
    const x = plot.x + index * slot + (slot - barWidth) / 2;
    const paperTokens = Math.max(0, toFiniteNumber(day.paperTokens));
    const libraryTokens = Math.max(0, toFiniteNumber(day.libraryTokens));
    const segments: UsageChartSegment[] = [];
    let cursor = plot.y + plot.height;
    for (const [tokens, color] of [
      [paperTokens, palette.paper],
      [libraryTokens, palette.library],
    ] as const) {
      if (tokens <= 0) continue;
      const segmentHeight = (tokens / top) * plot.height;
      cursor -= segmentHeight;
      segments.push({
        y: cursor,
        height: segmentHeight,
        color,
        roundTop: false,
      });
    }
    if (segments.length) segments[segments.length - 1]!.roundTop = true;
    return { localDate: day.localDate, x, width: barWidth, segments };
  });
  const xTicks: Array<{ x: number; label: string }> = [];
  if (days.length) {
    const seen = new Set<number>();
    const ticks = Math.min(USAGE_CHART_MAX_X_TICKS, days.length);
    for (let index = 0; index < ticks; index += 1) {
      const position =
        ticks === 1 ? 0 : Math.round((index * (days.length - 1)) / (ticks - 1));
      if (seen.has(position)) continue;
      seen.add(position);
      xTicks.push({
        x: plot.x + position * slot + slot / 2,
        label: formatUsageShortDateLabel(days[position]!.localDate),
      });
    }
  }
  return { width, height, plot, max, bars, yTicks, xTicks };
}

/**
 * A rectangle whose top two corners are rounded.
 *
 * A stacked bar cannot use `rx` on a `<rect>`: that would round all four
 * corners and cut a notch into the join between the paper and library
 * segments. A bar too short or too narrow for the radius falls back to square
 * corners rather than curling back on itself.
 */
export function roundedTopRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  const right = x + width;
  const bottom = y + height;
  const r = Math.min(radius, width / 2, height);
  if (!(r > 0) || height <= radius || width <= radius * 2) {
    return `M${round(x)} ${round(bottom)} L${round(x)} ${round(y)} L${round(right)} ${round(y)} L${round(right)} ${round(bottom)} Z`;
  }
  return (
    `M${round(x)} ${round(bottom)} L${round(x)} ${round(y + r)} ` +
    `Q${round(x)} ${round(y)} ${round(x + r)} ${round(y)} ` +
    `L${round(right - r)} ${round(y)} ` +
    `Q${round(right)} ${round(y)} ${round(right)} ${round(y + r)} ` +
    `L${round(right)} ${round(bottom)} Z`
  );
}

/** Runtimes users know by name, not by their internal id. */
const RUNTIME_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

/**
 * Where a model's tokens came from: its provider, or the runtime that ran it.
 *
 * The same model can appear twice — once called directly through its API, once
 * driven by Claude Code or Codex — and two rows sharing one name with two
 * different token totals read as a bug. This is what tells them apart.
 */
export function describeUsageModelSource(model: {
  provider: string | null;
  runtimes: readonly string[];
}): string {
  const provider = (model.provider || "").trim();
  if (provider) return provider;
  const runtimes = model.runtimes
    .map((runtime) => RUNTIME_DISPLAY_NAMES[runtime] || runtime)
    .filter(Boolean);
  return runtimes.join(", ");
}

/**
 * The one line that admits which tokens in a range are reconstructed.
 *
 * Turns from before the ledger existed are rebuilt from stored chat history
 * (`src/utils/usageHistoryBackfill.ts`): their input tokens are the size of the
 * prompt the plugin assembled, and their output tokens are estimated from the
 * stored answer AND the stored reasoning, which a thinking model is billed for
 * too (`src/utils/usageTokenEstimate.ts`). Neither is a billed count. Question counts and papers stay exact -- they come from real messages
 * -- so only the token copy carries this.
 */
export function describeUsageEstimateNote(input: {
  estimatedTurns?: number;
}): string | null {
  const estimated = Math.max(0, Math.floor(input.estimatedTurns || 0));
  if (!estimated) return null;
  return usageText(
    plural(
      estimated,
      "Includes {count} turn from before this tab existed: its tokens are" +
        " estimated from the stored text.",
      "Includes {count} turns from before this tab existed: their tokens are" +
        " estimated from the stored text.",
    ),
    { count: formatUsageCount(estimated) },
  );
}

/**
 * What the "Reset statistics" dialog says before anything is deleted.
 *
 * The dialog has to name the one loss the user cannot see coming. The turns
 * from before this tab existed were reconstructed once, by a one-time pass
 * over stored conversations (`src/utils/usageHistoryBackfill.ts`) that is
 * marked done per profile and never runs again -- so a reset takes that whole
 * reconstructed history with it and nothing will bring it back. A ledger with
 * no reconstructed rows has nothing extra to admit, and says exactly what it
 * always said.
 */
export function describeUsageResetConfirmation(input: {
  events: number;
  /** Rows written by the history backfill, counted fresh from the ledger. */
  historyEstimateRows?: number;
}): string {
  const events = Math.max(0, Math.round(toFiniteNumber(input.events)));
  const reconstructed = Math.max(
    0,
    Math.round(toFiniteNumber(input.historyEstimateRows || 0)),
  );
  const paragraphs = [
    usageText(
      plural(
        events,
        "This deletes the {count} recorded usage row from your local database:" +
          " every question count and token total in this tab goes back to zero.",
        "This deletes all {count} recorded usage rows from your local database:" +
          " every question count and token total in this tab goes back to zero.",
      ),
      { count: formatUsageCount(events) },
    ),
  ];
  if (reconstructed > 0) {
    paragraphs.push(
      usageText(
        plural(
          reconstructed,
          "This includes the {count} turn reconstructed from your earlier" +
            " conversations; it will not be rebuilt.",
          "This includes the {count} turns reconstructed from your earlier" +
            " conversations; they will not be rebuilt.",
        ),
        { count: formatUsageCount(reconstructed) },
      ),
    );
  }
  paragraphs.push(
    t(
      "Your conversations, notes and papers are not touched, and this cannot be undone.",
    ),
  );
  return paragraphs.join("\n\n");
}

export type UsageTokensCardCopy = { value: string; sub: string };

/**
 * What the Tokens card says.
 *
 * Zero is not a safe default here. A turn whose provider never reported usage
 * is stored with zero tokens and `token_source = 'unreported'`, and printing
 * "0" for it would tell the user the turn was free when nobody knows what it
 * cost. So a range with turns but no measured tokens gets an em dash and says
 * why, and a range with both says how many turns are missing from the total.
 */
export function describeUsageTokensCard(input: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  unreportedTurns?: number;
  /** Turns recorded in the range, so "empty range" is distinguishable. */
  questions?: number;
}): UsageTokensCardCopy {
  const unreported = Math.max(0, Math.floor(input.unreportedTurns || 0));
  if (input.totalTokens > 0) {
    const split = usageText("{prompt} in · {completion} out", {
      prompt: formatUsageTokens(input.promptTokens),
      completion: formatUsageTokens(input.completionTokens),
    });
    return {
      value: formatUsageTokens(input.totalTokens),
      sub:
        unreported > 0
          ? usageText("{split} · {count} unreported", {
              split,
              count: formatUsageCount(unreported),
            })
          : split,
    };
  }
  if (unreported > 0) {
    return { value: "—", sub: t("not reported by the provider") };
  }
  if ((input.questions || 0) > 0) {
    return { value: "—", sub: t("no tokens recorded in this range") };
  }
  return { value: "—", sub: t("no usage in this range") };
}

export type UsageEmptyState = "none" | "range" | null;

/**
 * Which "nothing to show" the panel is in, if either.
 *
 * `none` means the ledger is empty and the panel should explain itself instead
 * of drawing empty charts; `range` means the filter, not the plugin, is why
 * the numbers are zero.
 */
export function resolveUsageEmptyState(input: {
  hasAnyUsage: boolean;
  rangeHasUsage: boolean;
}): UsageEmptyState {
  if (!input.hasAnyUsage) return "none";
  if (!input.rangeHasUsage) return "range";
  return null;
}

const CSV_COLUMNS = [
  "local_date",
  "timestamp",
  "mode",
  "model",
  "provider",
  "runtime",
  "conversation_key",
  "paper_item_id",
  "library_id",
  "counts_as_question",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "token_source",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The user's own rows, as a spreadsheet can read them.
 *
 * CRLF line endings and RFC 4180 quoting, so the file opens the same way on
 * Windows and macOS.
 */
export function serializeUsageEventsCsv(
  rows: readonly StoredUsageEvent[],
): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.localDate),
        csvCell(new Date(row.timestamp).toISOString()),
        csvCell(row.mode),
        csvCell(row.model),
        csvCell(row.provider),
        csvCell(row.runtime),
        csvCell(row.conversationKey),
        csvCell(row.paperItemID),
        csvCell(row.libraryID),
        csvCell(row.countsAsQuestion ? 1 : 0),
        csvCell(row.promptTokens),
        csvCell(row.completionTokens),
        csvCell(row.totalTokens),
        csvCell(row.cacheReadTokens),
        csvCell(row.cacheWriteTokens),
        csvCell(row.tokenSource),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Default save name, dated in the user's own calendar. */
export function usageCsvFileName(now: number = Date.now()): string {
  const date = new Date(now);
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `llm-for-zotero-usage-${stamp}.csv`;
}
