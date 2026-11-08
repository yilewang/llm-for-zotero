/**
 * Pure state for the standalone window's pinned papers (no DOM, no Zotero):
 * the papers listed under "Pinned papers" in the window's sidebar, whose
 * place (main chat and side panel tabs) is kept while the user works on
 * another paper, and the dot each row shows.
 */

/** At most this many papers are pinned; pinning one more drops the oldest. */
export const MAX_PINNED_PAPERS = 20;

function positiveInt(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Reads the saved list (a JSON array of paper item IDs); bad input is []. */
export function parsePinnedPaperIDs(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: number[] = [];
  for (const entry of parsed) {
    const id = positiveInt(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(-MAX_PINNED_PAPERS);
}

export function serializePinnedPaperIDs(ids: readonly number[]): string {
  return JSON.stringify(parsePinnedPaperIDs(JSON.stringify(ids)));
}

/** Pins the paper at the end of the list, or unpins it if pinned. */
export function togglePinnedPaper(
  ids: readonly number[],
  paperID: number,
): number[] {
  const id = positiveInt(paperID);
  if (!id) return [...ids];
  if (ids.includes(id)) return ids.filter((entry) => entry !== id);
  return [...ids, id].slice(-MAX_PINNED_PAPERS);
}

export type PinnedPaperDot = "writing" | "ready" | null;

/**
 * A pinned paper's dot: "writing" while its chat answers, "ready" once an
 * answer finished while the paper was not on screen, until it is shown.
 */
export function resolvePinnedPaperDot(params: {
  writing: boolean;
  readyUnseen: boolean;
}): PinnedPaperDot {
  if (params.writing) return "writing";
  return params.readyUnseen ? "ready" : null;
}

/**
 * The papers with an answer waiting, after a chat's request started or
 * ended. An answer that ends while its paper is not on screen waits until
 * the paper is shown again.
 */
export function updateReadyPinnedPapers(
  ready: ReadonlySet<number>,
  params: {
    paperID: number;
    pending: boolean;
    shownPaperID: number | null;
  },
): Set<number> {
  const next = new Set(ready);
  const id = positiveInt(params.paperID);
  if (!id) return next;
  if (params.pending || id === params.shownPaperID) next.delete(id);
  else next.add(id);
  return next;
}
