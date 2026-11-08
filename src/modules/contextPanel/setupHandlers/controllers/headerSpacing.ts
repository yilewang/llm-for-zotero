/** Compression moves in steps of this size, so tiny width changes keep it. */
const COMPRESSION_STEP = 0.05;

/** The smallest whole step that covers a shortage of this many pixels. */
function compressionFor(shortage: number, available: number): number {
  const needed = Math.min(1, Math.max(0, shortage / available));
  return Math.min(
    1,
    Math.ceil(needed / COMPRESSION_STEP - 1e-6) * COMPRESSION_STEP,
  );
}

/**
 * The compression to apply, given the current one and the shortage at full
 * spacing. It grows as soon as the header does not fit, but shrinks only
 * when a lower step still leaves a pixel to spare. Without that band, a
 * shortage that wobbles across a step line by a fraction of a pixel flips
 * the compression on every frame, and each flip resizes the whole pane.
 */
export function nextRuntimeCompression(
  current: number,
  shortage: number,
  available: number,
): number {
  const grow = compressionFor(shortage, available);
  if (grow > current + 1e-6) return grow;
  const shrink = compressionFor(shortage + 1, available);
  if (shrink < current - 1e-6) return shrink;
  return current;
}

/** Reclaim only the runtime group's empty space, and only when it is needed. */
export function updateHeaderSpacing(header: HTMLElement | null): void {
  if (!header || !header.getBoundingClientRect().width) return;
  const runtime = header.querySelector<HTMLElement>(
    ".llm-header-runtime-controls",
  );
  const actions = header.querySelector<HTMLElement>(".llm-header-actions");
  if (!runtime || !actions) return;

  const buttons = (
    Array.from(
      runtime.querySelectorAll(".llm-runtime-system-toggle"),
    ) as HTMLElement[]
  ).filter((button) => button.getBoundingClientRect().width > 0);
  if (!buttons.length) return;
  const gap =
    parseFloat(
      header.ownerDocument.defaultView?.getComputedStyle(header)?.columnGap ||
        "0",
    ) || 0;
  // Each button can give up 6px; the group and chip gaps contribute 2px and 4px.
  const available = buttons.length * 6 + (buttons.length - 1) * 2 + 4;
  // Measured as laid out now. The compressed widths are minimum widths, so
  // Zotero sizes the whole pane from them: un-compressing to measure (as
  // this did) resized the pane on every pass, which changed the measurement
  // and the next compression, and the panel re-laid itself out on every
  // frame. Adding back what the current compression took gives the
  // shortage at full spacing without writing anything.
  const written = header.style.getPropertyValue("--llm-runtime-compression");
  const current = parseFloat(written) || 0;
  const shortage =
    runtime.getBoundingClientRect().right +
    gap -
    actions.getBoundingClientRect().left +
    current * available;
  const next = nextRuntimeCompression(current, shortage, available);
  if (written && next === current) return;
  header.style.setProperty(
    "--llm-runtime-compression",
    next > 0 ? next.toFixed(2) : "0",
  );
}
