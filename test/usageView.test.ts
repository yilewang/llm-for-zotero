import { assert } from "chai";
import {
  USAGE_DARK_PALETTE,
  USAGE_HEATMAP_EMPTY_LEVEL,
  USAGE_HEATMAP_RAMP,
  USAGE_HEATMAP_RAMP_DARK,
  USAGE_LIGHT_PALETTE,
  USAGE_LIBRARY_COLOR,
  USAGE_PAPER_COLOR,
  buildUsageHeatmapGrid,
  buildUsageTokenChartModel,
  describeUsageHeatmapPopover,
  describeUsageHeatmapSummary,
  describeUsageEstimateNote,
  describeUsageModelSource,
  describeUsageResetConfirmation,
  describeUsageTokensCard,
  formatUsageAxisTokens,
  formatUsageCount,
  formatUsageDateLabel,
  formatUsageShortDateLabel,
  formatUsageTokens,
  placeUsagePopover,
  resolveUsageEmptyState,
  resolveUsageHeatmapDays,
  resolveUsagePalette,
  roundedTopRectPath,
  serializeUsageEventsCsv,
  usageCsvFileName,
  usageHeatmapLevel,
  USAGE_POPOVER_OFFSET,
} from "../src/utils/usageView";
import type { UsageHeatmapDay } from "../src/utils/usageStats";
import type { StoredUsageEvent } from "../src/utils/usageStore";

/** Ascending, contiguous days starting at `start`, one value per entry. */
function makeDays(
  start: string,
  questions: number[],
  papers?: number[],
): UsageHeatmapDay[] {
  const [year, month, day] = start.split("-").map(Number);
  return questions.map((value, index) => {
    const date = new Date(year!, month! - 1, day! + index, 12);
    const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return {
      localDate,
      questions: value,
      distinctPapers: papers ? (papers[index] ?? 0) : 0,
      totalTokens: 0,
      providerRows: value,
      unreportedRows: 0,
      estimateRows: 0,
    };
  });
}

describe("usage view formatting", function () {
  it("rounds counts to integers with thousands separators", function () {
    assert.equal(formatUsageCount(0), "0");
    assert.equal(formatUsageCount(7), "7");
    assert.equal(formatUsageCount(1234), "1,234");
    assert.equal(formatUsageCount(12.6), "13");
  });

  it("abbreviates tokens with k and one decimal for millions", function () {
    assert.equal(formatUsageTokens(0), "0");
    assert.equal(formatUsageTokens(940), "940");
    assert.equal(formatUsageTokens(1000), "1k");
    assert.equal(formatUsageTokens(1200), "1.2k");
    assert.equal(formatUsageTokens(12345), "12.3k");
    assert.equal(formatUsageTokens(1_250_000), "1.3M");
    assert.equal(formatUsageTokens(2_000_000), "2M");
  });

  it("labels chart axis ticks in k", function () {
    assert.equal(formatUsageAxisTokens(0), "0");
    assert.equal(formatUsageAxisTokens(1000), "1k");
    assert.equal(formatUsageAxisTokens(2500), "2.5k");
    assert.equal(formatUsageAxisTokens(40000), "40k");
    assert.equal(formatUsageAxisTokens(1_500_000), "1.5M");
  });

  it("formats local dates without timezone drift", function () {
    assert.equal(formatUsageDateLabel("2026-03-12"), "12 Mar 2026");
    assert.equal(formatUsageDateLabel("2026-01-01"), "1 Jan 2026");
    assert.equal(formatUsageShortDateLabel("2026-03-12"), "12 Mar");
  });
});

describe("usage palette", function () {
  it("keeps the light palette exactly as the spec fixes it", function () {
    assert.deepEqual(
      [...USAGE_LIGHT_PALETTE.ramp],
      ["#EAF3DE", "#C0DD97", "#97C459", "#639922", "#3B6D11"],
    );
    assert.equal(USAGE_LIGHT_PALETTE.paper, "#8A5A3C");
    assert.equal(USAGE_LIGHT_PALETTE.library, "#C79463");
  });

  it("runs the dark ramp dim-to-vivid so low activity never glows", function () {
    assert.deepEqual(
      [...USAGE_HEATMAP_RAMP_DARK],
      ["#1B2A12", "#2B4A16", "#3E6B1C", "#5F9A26", "#8FCB4D"],
    );
    assert.deepEqual(
      [...USAGE_DARK_PALETTE.ramp],
      [...USAGE_HEATMAP_RAMP_DARK],
    );
    // It is not the light ramp reversed: near-white is never a data colour on
    // a dark pane.
    assert.notDeepEqual(
      [...USAGE_DARK_PALETTE.ramp],
      [...USAGE_HEATMAP_RAMP].reverse(),
    );
    for (const stop of USAGE_DARK_PALETTE.ramp) {
      assert.notInclude(USAGE_HEATMAP_RAMP, stop);
    }
  });

  it("separates the two browns again on a dark pane", function () {
    assert.equal(USAGE_DARK_PALETTE.paper, "#B07E57");
    assert.equal(USAGE_DARK_PALETTE.library, "#E0B487");
  });

  it("selects a palette by colour scheme", function () {
    assert.strictEqual(resolveUsagePalette("light"), USAGE_LIGHT_PALETTE);
    assert.strictEqual(resolveUsagePalette("dark"), USAGE_DARK_PALETTE);
  });
});

describe("usage heatmap model", function () {
  it("buckets a value into one of five ramp levels, zero staying empty", function () {
    assert.equal(usageHeatmapLevel(0, 10), USAGE_HEATMAP_EMPTY_LEVEL);
    assert.equal(usageHeatmapLevel(1, 10), 1);
    assert.equal(usageHeatmapLevel(2, 10), 1);
    assert.equal(usageHeatmapLevel(3, 10), 2);
    assert.equal(usageHeatmapLevel(10, 10), 5);
    assert.equal(usageHeatmapLevel(1, 1), 5);
    assert.equal(usageHeatmapLevel(4, 0), USAGE_HEATMAP_EMPTY_LEVEL);
  });

  it("exposes exactly the five spec ramp stops", function () {
    assert.deepEqual(
      [...USAGE_HEATMAP_RAMP],
      ["#EAF3DE", "#C0DD97", "#97C459", "#639922", "#3B6D11"],
    );
    assert.equal(USAGE_PAPER_COLOR, "#8A5A3C");
    assert.equal(USAGE_LIBRARY_COLOR, "#C79463");
  });

  it("places each day in a weekday row and a week column", function () {
    // 2026-03-01 is a Sunday, so the grid starts flush at column 0 row 0.
    const days = makeDays(
      "2026-03-01",
      new Array(21).fill(0).map((_, i) => i),
    );
    const grid = buildUsageHeatmapGrid(days, "questions");
    assert.equal(grid.columns, 3);
    assert.equal(grid.cells.length, 21);
    const first = grid.cells[0]!;
    assert.deepEqual(
      { column: first.column, row: first.row, date: first.localDate },
      { column: 0, row: 0, date: "2026-03-01" },
    );
    const tenth = grid.cells.find((c) => c.localDate === "2026-03-10")!;
    assert.deepEqual(
      { column: tenth.column, row: tenth.row },
      { column: 1, row: 2 },
    );
    assert.equal(grid.max, 20);
  });

  it("offsets the first column when the window does not start on a Sunday", function () {
    // 2026-03-04 is a Wednesday: row 3 of column 0.
    const days = makeDays("2026-03-04", [1, 2, 3]);
    const grid = buildUsageHeatmapGrid(days, "questions");
    assert.equal(grid.cells[0]!.row, 3);
    assert.equal(grid.cells[0]!.column, 0);
    assert.equal(grid.cells[2]!.row, 5);
  });

  it("labels Mon, Wed and Fri rows only", function () {
    const grid = buildUsageHeatmapGrid(
      makeDays("2026-03-01", [1]),
      "questions",
    );
    assert.deepEqual(grid.weekdayLabels, [
      { row: 1, label: "Mon" },
      { row: 3, label: "Wed" },
      { row: 5, label: "Fri" },
    ]);
  });

  it("labels the column where each month starts, without crowding", function () {
    const days = makeDays("2026-03-01", new Array(70).fill(1));
    const grid = buildUsageHeatmapGrid(days, "questions");
    assert.deepEqual(grid.monthLabels, [
      { column: 0, label: "Mar" },
      { column: 5, label: "Apr" },
      { column: 9, label: "May" },
    ]);
  });

  it("does not label the first column when it starts late in a month", function () {
    const days = makeDays("2026-03-22", new Array(21).fill(1));
    const grid = buildUsageHeatmapGrid(days, "questions");
    assert.deepEqual(grid.monthLabels, [{ column: 2, label: "Apr" }]);
  });

  it("reads the metric it is told to and keeps a zero day empty", function () {
    const days = makeDays("2026-03-01", [1, 2], [1, 0]);
    const questions = buildUsageHeatmapGrid(days, "questions");
    assert.deepEqual(
      questions.cells.map((cell) => cell.value),
      [1, 2],
    );
    const papers = buildUsageHeatmapGrid(days, "papers");
    assert.deepEqual(
      papers.cells.map((cell) => cell.value),
      [1, 0],
    );
    assert.equal(papers.cells[1]!.level, USAGE_HEATMAP_EMPTY_LEVEL);
    // The hover popover replaced the native `<title>`, so a cell carries no
    // copy of its own any more: the day's wording is built on hover.
    assert.notProperty(questions.cells[0]!, "tooltip");
  });

  it("summarises each metric against active days", function () {
    const heatmap = {
      startDate: "2026-03-01",
      endDate: "2026-03-07",
      days: [],
      totalQuestions: 42,
      activeDays: 5,
      distinctPapers: 9,
    };
    assert.equal(
      describeUsageHeatmapSummary(heatmap, "questions"),
      "42 questions across 5 active days",
    );
    assert.equal(
      describeUsageHeatmapSummary(heatmap, "papers"),
      "9 distinct papers across 5 active days",
    );
    assert.equal(
      describeUsageHeatmapSummary(
        { ...heatmap, totalQuestions: 1, activeDays: 1, distinctPapers: 1 },
        "questions",
      ),
      "1 question across 1 active day",
    );
  });

  it("shrinks the heatmap window to the history that exists", function () {
    const now = new Date(2026, 2, 20, 12).getTime();
    assert.equal(resolveUsageHeatmapDays(null, now), 56);
    assert.equal(resolveUsageHeatmapDays("2026-03-18", now), 56);
    assert.equal(resolveUsageHeatmapDays("2026-02-01", now), 56);
    assert.equal(resolveUsageHeatmapDays("2026-01-01", now), 91);
    assert.equal(resolveUsageHeatmapDays("2025-11-01", now), 182);
    assert.equal(resolveUsageHeatmapDays("2025-01-01", now), 365);
  });
});

describe("usage heatmap popover copy", function () {
  /** A day with the provenance the popover has to read. */
  function day(overrides: Partial<UsageHeatmapDay> = {}): UsageHeatmapDay {
    return {
      localDate: "2026-09-18",
      questions: 3,
      distinctPapers: 2,
      totalTokens: 42_100,
      providerRows: 3,
      unreportedRows: 0,
      estimateRows: 0,
      ...overrides,
    };
  }

  it("names the day, the questions, and the tokens", function () {
    assert.deepEqual(
      describeUsageHeatmapPopover(day(), "questions", { locale: "en-US" }),
      ["Fri, Sep 18, 2026", "3 questions", "42.1k tokens"],
    );
  });

  it("writes the singular when the day holds exactly one", function () {
    assert.deepEqual(
      describeUsageHeatmapPopover(
        day({ questions: 1, totalTokens: 900, providerRows: 1 }),
        "questions",
        { locale: "en-US" },
      ),
      ["Fri, Sep 18, 2026", "1 question", "900 tokens"],
    );
  });

  it("counts papers instead of questions in Papers mode", function () {
    assert.deepEqual(
      describeUsageHeatmapPopover(day(), "papers", { locale: "en-US" }),
      ["Fri, Sep 18, 2026", "2 papers", "42.1k tokens"],
    );
    assert.equal(
      describeUsageHeatmapPopover(day({ distinctPapers: 1 }), "papers", {
        locale: "en-US",
      })[1],
      "1 paper",
    );
  });

  it("admits when the day's tokens are an estimate", function () {
    assert.equal(
      describeUsageHeatmapPopover(
        day({ providerRows: 2, estimateRows: 1 }),
        "questions",
        { locale: "en-US" },
      )[2],
      "42.1k tokens · estimate",
    );
  });

  it("says the tokens were never reported rather than printing zero", function () {
    const lines = describeUsageHeatmapPopover(
      day({ totalTokens: 0, providerRows: 0, unreportedRows: 3 }),
      "questions",
      { locale: "en-US" },
    );
    assert.equal(lines[2], "Tokens not reported");
    assert.notInclude(lines.join(" "), "0 tokens");
  });

  it("reports a quiet day in two lines, with no token claim at all", function () {
    assert.deepEqual(
      describeUsageHeatmapPopover(
        day({
          questions: 0,
          distinctPapers: 0,
          totalTokens: 0,
          providerRows: 0,
        }),
        "questions",
        { locale: "en-US" },
      ),
      ["Fri, Sep 18, 2026", "No activity"],
    );
  });

  it("writes the date in the locale it is given", function () {
    // The locale, not this module, decides the order and the separators.
    assert.match(
      describeUsageHeatmapPopover(day(), "questions", { locale: "en-GB" })[0]!,
      /^Fri, 18 Sept? 2026$/,
    );
    assert.equal(
      describeUsageHeatmapPopover(day(), "questions", { locale: "zh-CN" })[0],
      "2026年9月18日周五",
    );
    // A locale the runtime cannot resolve must not take the popover down.
    assert.include(
      describeUsageHeatmapPopover(day(), "questions", {
        locale: "not-a-locale",
      })[0],
      "2026",
    );
  });
});

describe("usage popover placement", function () {
  const base = {
    popoverWidth: 120,
    popoverHeight: 48,
    containerWidth: 600,
    containerHeight: 400,
  };

  it("sits just below and right of the pointer with room to spare", function () {
    assert.deepEqual(
      placeUsagePopover({ ...base, pointerX: 100, pointerY: 80 }),
      {
        left: 100 + USAGE_POPOVER_OFFSET,
        top: 80 + USAGE_POPOVER_OFFSET,
        flippedX: false,
        flippedY: false,
      },
    );
  });

  it("flips to the left of the pointer at the right edge", function () {
    const placed = placeUsagePopover({ ...base, pointerX: 560, pointerY: 80 });
    assert.isTrue(placed.flippedX);
    assert.equal(placed.left, 560 - USAGE_POPOVER_OFFSET - base.popoverWidth);
    assert.isAtMost(placed.left + base.popoverWidth, base.containerWidth);
  });

  it("flips above the pointer at the bottom edge", function () {
    const placed = placeUsagePopover({ ...base, pointerX: 100, pointerY: 380 });
    assert.isTrue(placed.flippedY);
    assert.equal(placed.top, 380 - USAGE_POPOVER_OFFSET - base.popoverHeight);
    assert.isAtMost(placed.top + base.popoverHeight, base.containerHeight);
  });

  it("flips both ways in the bottom-right corner", function () {
    const placed = placeUsagePopover({ ...base, pointerX: 590, pointerY: 395 });
    assert.isTrue(placed.flippedX);
    assert.isTrue(placed.flippedY);
    assert.isAtLeast(placed.left, 0);
    assert.isAtLeast(placed.top, 0);
  });

  it("never pushes the card off the top or left when it cannot fit", function () {
    const placed = placeUsagePopover({
      ...base,
      pointerX: 4,
      pointerY: 4,
      containerWidth: 100,
      containerHeight: 40,
    });
    assert.equal(placed.left, 0);
    assert.equal(placed.top, 0);
  });
});

describe("usage token chart model", function () {
  const days = [
    {
      localDate: "2026-03-01",
      paperTokens: 0,
      libraryTokens: 0,
      totalTokens: 0,
    },
    {
      localDate: "2026-03-02",
      paperTokens: 600,
      libraryTokens: 400,
      totalTokens: 1000,
    },
    {
      localDate: "2026-03-03",
      paperTokens: 1000,
      libraryTokens: 2000,
      totalTokens: 3000,
    },
  ];

  it("scales to a nice axis maximum with four y ticks", function () {
    const model = buildUsageTokenChartModel(days, { width: 400 });
    assert.equal(model.max, 3000);
    assert.deepEqual(
      model.yTicks.map((tick) => tick.label),
      ["0", "1k", "2k", "3k"],
    );
    assert.equal(model.yTicks[0]!.y, model.plot.y + model.plot.height);
    assert.equal(model.yTicks[3]!.y, model.plot.y);
  });

  it("stacks paper below library and rounds only the top segment", function () {
    const model = buildUsageTokenChartModel(days, { width: 400 });
    assert.equal(model.bars.length, 3);
    assert.deepEqual(model.bars[0]!.segments, []);
    const tall = model.bars[2]!;
    assert.equal(tall.segments.length, 2);
    assert.equal(tall.segments[0]!.color, USAGE_PAPER_COLOR);
    assert.isFalse(tall.segments[0]!.roundTop);
    assert.equal(tall.segments[1]!.color, USAGE_LIBRARY_COLOR);
    assert.isTrue(tall.segments[1]!.roundTop);
    // Paper sits on the baseline; library sits directly on top of it.
    assert.closeTo(
      tall.segments[0]!.y + tall.segments[0]!.height,
      model.plot.y + model.plot.height,
      1e-9,
    );
    assert.closeTo(
      tall.segments[1]!.y + tall.segments[1]!.height,
      tall.segments[0]!.y,
      1e-9,
    );
    // Full-height day reaches the top of the plot.
    assert.closeTo(tall.segments[1]!.y, model.plot.y, 1e-9);
  });

  it("paints the bars in the palette it is given", function () {
    const model = buildUsageTokenChartModel(days, {
      width: 400,
      palette: USAGE_DARK_PALETTE,
    });
    const tall = model.bars[2]!;
    assert.equal(tall.segments[0]!.color, USAGE_DARK_PALETTE.paper);
    assert.equal(tall.segments[1]!.color, USAGE_DARK_PALETTE.library);
  });

  it("rounds the top of a single-mode bar", function () {
    const model = buildUsageTokenChartModel(
      [
        {
          localDate: "2026-03-01",
          paperTokens: 500,
          libraryTokens: 0,
          totalTokens: 500,
        },
      ],
      { width: 400 },
    );
    const segments = model.bars[0]!.segments;
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.color, USAGE_PAPER_COLOR);
    assert.isTrue(segments[0]!.roundTop);
  });

  it("gives bars about seventy percent of their slot", function () {
    const model = buildUsageTokenChartModel(days, { width: 400 });
    const slot = model.plot.width / days.length;
    assert.closeTo(model.bars[0]!.width, slot * 0.7, 0.001);
    assert.closeTo(
      model.bars[0]!.x,
      model.plot.x + (slot - slot * 0.7) / 2,
      0.001,
    );
  });

  it("never draws more than seven x ticks and always keeps the ends", function () {
    const many = new Array(30).fill(0).map((_, index) => ({
      localDate: `2026-03-${String(index + 1).padStart(2, "0")}`,
      paperTokens: index,
      libraryTokens: 0,
      totalTokens: index,
    }));
    const model = buildUsageTokenChartModel(many, { width: 500 });
    assert.isAtMost(model.xTicks.length, 7);
    assert.equal(model.xTicks[0]!.label, "1 Mar");
    assert.equal(model.xTicks[model.xTicks.length - 1]!.label, "30 Mar");
  });

  it("keeps a usable axis when there is no usage at all", function () {
    const model = buildUsageTokenChartModel(
      [
        {
          localDate: "2026-03-01",
          paperTokens: 0,
          libraryTokens: 0,
          totalTokens: 0,
        },
      ],
      { width: 400 },
    );
    assert.equal(model.max, 0);
    assert.deepEqual(model.bars[0]!.segments, []);
    assert.equal(model.yTicks.length, 4);
  });

  it("draws a rounded-top rectangle path", function () {
    assert.equal(
      roundedTopRectPath(10, 20, 8, 30, 2),
      "M10 50 L10 22 Q10 20 12 20 L16 20 Q18 20 18 22 L18 50 Z",
    );
    // A bar shorter than the radius must not curl back on itself.
    assert.equal(roundedTopRectPath(0, 0, 8, 1, 2), "M0 1 L0 0 L8 0 L8 1 Z");
  });
});

describe("usage estimate note", function () {
  it("says nothing when every token in the range was measured", function () {
    assert.isNull(describeUsageEstimateNote({ estimatedTurns: 0 }));
    assert.isNull(describeUsageEstimateNote({}));
  });

  it("names the estimated turns and says both numbers are estimates", function () {
    assert.strictEqual(
      describeUsageEstimateNote({ estimatedTurns: 1 }),
      "Includes 1 turn from before this tab existed: its tokens are estimated from the stored text.",
    );
    assert.strictEqual(
      describeUsageEstimateNote({ estimatedTurns: 1240 }),
      "Includes 1,240 turns from before this tab existed: their tokens are estimated from the stored text.",
    );
  });
});

describe("usage reset confirmation copy", function () {
  const SCOPE_MANY =
    "This deletes all 412 recorded usage rows from your local database:" +
    " every question count and token total in this tab goes back to zero.";
  const REASSURANCE =
    "Your conversations, notes and papers are not touched, and this cannot be" +
    " undone.";

  it("says only what it always said when nothing was reconstructed", function () {
    assert.strictEqual(
      describeUsageResetConfirmation({ events: 412 }),
      `${SCOPE_MANY}\n\n${REASSURANCE}`,
    );
    assert.strictEqual(
      describeUsageResetConfirmation({ events: 412, historyEstimateRows: 0 }),
      `${SCOPE_MANY}\n\n${REASSURANCE}`,
    );
  });

  it("still counts one row in the singular", function () {
    assert.strictEqual(
      describeUsageResetConfirmation({ events: 1 }),
      "This deletes the 1 recorded usage row from your local database:" +
        " every question count and token total in this tab goes back to zero." +
        `\n\n${REASSURANCE}`,
    );
  });

  it("warns that one reconstructed turn will not be rebuilt", function () {
    assert.strictEqual(
      describeUsageResetConfirmation({ events: 412, historyEstimateRows: 1 }),
      `${SCOPE_MANY}\n\n` +
        "This includes the 1 turn reconstructed from your earlier" +
        " conversations; it will not be rebuilt." +
        `\n\n${REASSURANCE}`,
    );
  });

  it("warns about a whole reconstructed history in the plural", function () {
    assert.strictEqual(
      describeUsageResetConfirmation({
        events: 4120,
        historyEstimateRows: 3708,
      }),
      "This deletes all 4,120 recorded usage rows from your local database:" +
        " every question count and token total in this tab goes back to zero." +
        "\n\nThis includes the 3,708 turns reconstructed from your earlier" +
        " conversations; they will not be rebuilt." +
        `\n\n${REASSURANCE}`,
    );
  });
});

describe("usage tokens card copy", function () {
  it("reports the total with an in/out split", function () {
    assert.deepEqual(
      describeUsageTokensCard({
        promptTokens: 18_400_000,
        completionTokens: 2_100_000,
        totalTokens: 20_500_000,
        questions: 900,
      }),
      { value: "20.5M", sub: "18.4M in · 2.1M out" },
    );
  });

  it("says how many turns are missing from a partial total", function () {
    assert.deepEqual(
      describeUsageTokensCard({
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        unreportedTurns: 3,
        questions: 10,
      }),
      { value: "1.2k", sub: "1k in · 200 out · 3 unreported" },
    );
  });

  it("separates an empty range from a range with untallied turns", function () {
    assert.deepEqual(
      describeUsageTokensCard({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        questions: 0,
      }),
      { value: "—", sub: "no usage in this range" },
    );
    assert.deepEqual(
      describeUsageTokensCard({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        questions: 4,
      }),
      { value: "—", sub: "no tokens recorded in this range" },
    );
  });
});

describe("usage model source labels", function () {
  it("names the provider that bills a model", function () {
    assert.equal(
      describeUsageModelSource({ provider: "anthropic", runtimes: ["chat"] }),
      "anthropic",
    );
  });

  it("falls back to the runtime when no provider was recorded", function () {
    assert.equal(
      describeUsageModelSource({ provider: null, runtimes: ["claude-code"] }),
      "Claude Code",
    );
    assert.equal(
      describeUsageModelSource({ provider: null, runtimes: ["codex"] }),
      "Codex",
    );
  });

  it("lists every runtime when a model was billed through several", function () {
    assert.equal(
      describeUsageModelSource({ provider: null, runtimes: ["agent", "chat"] }),
      "agent, chat",
    );
  });

  it("says nothing rather than inventing a source", function () {
    assert.equal(
      describeUsageModelSource({ provider: null, runtimes: [] }),
      "",
    );
  });
});

describe("usage empty states", function () {
  it("distinguishes never-used from nothing-in-this-range", function () {
    assert.equal(
      resolveUsageEmptyState({ hasAnyUsage: false, rangeHasUsage: false }),
      "none",
    );
    assert.equal(
      resolveUsageEmptyState({ hasAnyUsage: true, rangeHasUsage: false }),
      "range",
    );
    assert.isNull(
      resolveUsageEmptyState({ hasAnyUsage: true, rangeHasUsage: true }),
    );
  });
});

describe("usage CSV export", function () {
  const row: StoredUsageEvent = {
    id: 1,
    timestamp: Date.UTC(2026, 2, 12, 9, 30, 0),
    localDate: "2026-03-12",
    mode: "paper",
    conversationKey: 42,
    conversationInstanceID: "abc",
    libraryID: 1,
    paperItemID: 77,
    model: "gpt-5",
    provider: "openai",
    runtime: "chat",
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    countsAsQuestion: true,
    tokenSource: "provider",
  };

  it("writes a header and one CRLF-terminated line per row", function () {
    const csv = serializeUsageEventsCsv([row]);
    const lines = csv.split("\r\n");
    assert.equal(
      lines[0],
      "local_date,timestamp,mode,model,provider,runtime,conversation_key," +
        "paper_item_id,library_id,counts_as_question,prompt_tokens," +
        "completion_tokens,total_tokens,cache_read_tokens,cache_write_tokens," +
        "token_source",
    );
    assert.equal(
      lines[1],
      "2026-03-12,2026-03-12T09:30:00.000Z,paper,gpt-5,openai,chat,42,77,1,1,100,40,140,10,0,provider",
    );
    assert.equal(lines[2], "");
  });

  it("quotes values that carry commas, quotes or newlines", function () {
    const csv = serializeUsageEventsCsv([
      { ...row, model: 'weird, "model"', provider: "line\nbreak" },
    ]);
    const line = csv.split("\r\n")[1]!;
    assert.include(line, '"weird, ""model"""');
    assert.include(line, '"line\nbreak"');
  });

  it("leaves absent columns empty rather than writing null", function () {
    const csv = serializeUsageEventsCsv([
      {
        ...row,
        model: null,
        provider: null,
        runtime: null,
        paperItemID: null,
        libraryID: null,
        countsAsQuestion: false,
      },
    ]);
    assert.equal(
      csv.split("\r\n")[1],
      "2026-03-12,2026-03-12T09:30:00.000Z,paper,,,,42,,,0,100,40,140,10,0,provider",
    );
  });

  it("writes a header even when there is nothing to export", function () {
    assert.equal(serializeUsageEventsCsv([]).split("\r\n").length, 2);
  });

  it("names the file after the day it was exported", function () {
    assert.equal(
      usageCsvFileName(new Date(2026, 2, 12, 9).getTime()),
      "llm-for-zotero-usage-2026-03-12.csv",
    );
  });
});
