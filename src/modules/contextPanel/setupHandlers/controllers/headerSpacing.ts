/**
 * The Stacked header row fits in one of four stages. "full" shows every
 * action in 28px boxes. "compact" shows them all in 24px boxes with tighter
 * gaps between blocks. "menu" keeps those boxes and gaps and folds Settings,
 * Export and Delete into the More button. "tight" folds Task progress and
 * Open in window too, so the right block is only the More button. The
 * capsule has one width in every stage and at every plugin font scale (its
 * chip uses a fixed font size), so the stages differ only in the buttons.
 * zoteroPane.css sets the same box sizes and gaps from `data-fit`; keep the
 * two in step.
 */
export type HeaderFit = "full" | "compact" | "menu" | "tight";

/** Roomiest stage first. */
export const HEADER_FIT_STAGES: readonly HeaderFit[] = [
  "full",
  "compact",
  "menu",
  "tight",
];

/** The roomiest stage that folds anything into More. */
const FIRST_FOLDED_STAGE = HEADER_FIT_STAGES.indexOf("menu");

export const HEADER_FIT_METRICS: Readonly<
  Record<
    HeaderFit,
    {
      box: number;
      minGap: number;
      /** Settings, Export and Delete are in the More menu. */
      folded: boolean;
      /** Task progress and Open in window are in the More menu too. */
      foldedPinned: boolean;
    }
  >
> = {
  full: { box: 28, minGap: 10, folded: false, foldedPinned: false },
  compact: { box: 24, minGap: 8, folded: false, foldedPinned: false },
  menu: { box: 24, minGap: 8, folded: true, foldedPinned: false },
  tight: { box: 24, minGap: 8, folded: true, foldedPinned: true },
};

/** The gap between two buttons of one block. */
export const HEADER_BLOCK_GAP = 2;

/** A roomier stage needs this many pixels to spare before it is chosen. */
export const HEADER_FIT_SPARE = 1;

export type HeaderFitInput = {
  /** The row's width, padding included. */
  available: number;
  /** The row's left and right padding together. */
  padding: number;
  /** The capsule's width; it is the same in every stage. */
  capsule: number;
  /** New chat and history. */
  leftButtons: number;
  /** Task progress and Open in window: only the "tight" stage folds them. */
  pinnedRightButtons: number;
  /** Settings, Export and Delete: the "menu" and "tight" stages fold them. */
  foldableRightButtons: number;
  /**
   * False keeps the "full" and "compact" stages out of the choice. A web
   * chat's Exit button is a text button wider than a box, so the arithmetic
   * cannot count it; that row never shows it and Exit lives in the More
   * strip. Default true.
   */
  allowUnfolded?: boolean;
};

function blockWidth(buttons: number, box: number): number {
  return buttons > 0 ? buttons * box + (buttons - 1) * HEADER_BLOCK_GAP : 0;
}

/**
 * The width a stage needs, from button counts and constants alone. Nothing is
 * laid out to find it: the stages are minimum widths, so showing one to
 * measure it would resize the pane, which changes the measurement, and the
 * panel would re-lay itself out on every frame.
 */
export function headerFitRequiredWidth(
  stage: HeaderFit,
  input: HeaderFitInput,
): number {
  const { box, minGap, folded, foldedPinned } = HEADER_FIT_METRICS[stage];
  const pinned = foldedPinned ? 0 : input.pinnedRightButtons;
  const foldable = folded ? 0 : input.foldableRightButtons;
  // The More button shows when it holds anything.
  const hasMore =
    folded &&
    (input.foldableRightButtons > 0 ||
      (foldedPinned && input.pinnedRightButtons > 0));
  const rightButtons = pinned + foldable + (hasMore ? 1 : 0);
  return (
    input.padding +
    blockWidth(input.leftButtons, box) +
    input.capsule +
    blockWidth(rightButtons, box) +
    // The capsule sits one minGap after History (the button's end margin);
    // the actions keep at least one minGap from the left blocks (the row's
    // column gap). Free space falls only on the second.
    2 * minGap
  );
}

/**
 * The stage to show. With no current stage, the roomiest one that fits. With
 * one, a tighter stage is taken as soon as the current one does not fit, but
 * a roomier one only when it fits with HEADER_FIT_SPARE pixels to spare.
 * Without that band, a width that wobbles by a fraction of a pixel flips the
 * stage on every frame, and each flip changes the row.
 */
export function chooseHeaderFit(
  input: HeaderFitInput,
  current: HeaderFit | null,
): HeaderFit {
  const fits = (stage: HeaderFit, spare: number) =>
    headerFitRequiredWidth(stage, input) + spare <= input.available;
  const last = HEADER_FIT_STAGES.length - 1;
  const first = input.allowUnfolded === false ? FIRST_FOLDED_STAGE : 0;
  if (current && HEADER_FIT_STAGES.indexOf(current) < first) {
    current = HEADER_FIT_STAGES[first];
  }
  if (!current) {
    return (
      HEADER_FIT_STAGES.slice(first).find((stage) => fits(stage, 0)) ?? "tight"
    );
  }
  const index = HEADER_FIT_STAGES.indexOf(current);
  for (let i = first; i < index; i++) {
    if (fits(HEADER_FIT_STAGES[i], HEADER_FIT_SPARE)) {
      return HEADER_FIT_STAGES[i];
    }
  }
  if (fits(current, 0)) return current;
  for (let i = index + 1; i <= last; i++) {
    if (fits(HEADER_FIT_STAGES[i], 0)) return HEADER_FIT_STAGES[i];
  }
  return "tight";
}

function isHeaderFit(value: unknown): value is HeaderFit {
  return (
    typeof value === "string" &&
    (HEADER_FIT_STAGES as readonly string[]).includes(value)
  );
}

/** Counts a header button unless code hid it (Task progress does, inline). */
function shown(button: HTMLElement | null): boolean {
  return Boolean(button) && button!.style.display !== "none";
}

/**
 * Sets `data-fit` on the Stacked header row. It reads the row's width and the
 * capsule's width, which no stage changes, and counts the buttons; it never
 * switches a stage to measure it. It writes only when the stage changes.
 */
export function updateHeaderFit(row: HTMLElement | null): void {
  if (!row) return;
  const available = row.getBoundingClientRect().width;
  if (!available) return;
  const capsule = row.querySelector<HTMLElement>(
    ".llm-header-runtime-controls",
  );
  const capsuleWidth = capsule?.getBoundingClientRect().width || 0;
  if (!capsuleWidth) return;
  const style = row.ownerDocument.defaultView?.getComputedStyle(row);
  const padding =
    (parseFloat(style?.paddingLeft || "0") || 0) +
    (parseFloat(style?.paddingRight || "0") || 0);
  const count = (selectors: string[]) =>
    selectors.filter((selector) =>
      shown(row.querySelector<HTMLElement>(selector)),
    ).length;
  const next = chooseHeaderFit(
    {
      available,
      padding,
      capsule: capsuleWidth,
      leftButtons: count(["#llm-history-new", "#llm-history-toggle"]),
      pinnedRightButtons: count(["#llm-task-progress-toggle", "#llm-popout"]),
      foldableRightButtons: count([
        "#llm-settings",
        "#llm-export",
        "#llm-clear",
      ]),
      allowUnfolded:
        row.closest<HTMLElement>(".llm-panel")?.dataset.webchatMode !== "true",
    },
    isHeaderFit(row.dataset.fit) ? row.dataset.fit : null,
  );
  if (row.dataset.fit !== next) row.dataset.fit = next;
}
