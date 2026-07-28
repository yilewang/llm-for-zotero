import type { ZoteroGateway, AnnotationSnapshot } from "../../services/zoteroGateway";
import type { PdfPageService } from "../../services/pdfPageService";
import type { AgentToolContext, AgentToolDefinition } from "../../types";
import { pushUndoEntry, createUndoRedoPair } from "../../store/undoStore";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
} from "../shared";
import type { PaperContextRef } from "../../../shared/types";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";

// ── Types ────────────────────────────────────────────────────────────────────

type AnnotationEntry = {
  /** Annotation type. */
  type: "highlight" | "underline" | "note";
  /** The text to annotate (required for highlight / underline). */
  text?: string;
  /** Optional comment attached to the annotation. */
  comment?: string;
  /** Annotation colour label (e.g. "yellow", "green") or hex (e.g. "#FFD700"). */
  color?: string;
  /** Zero-based page index from search results. */
  pageIndex?: number;
  /** Printed page label from search results (e.g. "42"). */
  pageLabel?: string;
};

type CreateAnnotationInput = {
  /** The paper to annotate. */
  paperContext: PaperContextRef;
  /** One or more annotations to create on the paper's PDF. */
  annotations: AnnotationEntry[];
};

const SUPPORTED_TYPES = new Set(["highlight", "underline", "note"]);
const MAX_ANNOTATIONS = 20;

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeType(value: unknown): "highlight" | "underline" | "note" {
  if (typeof value !== "string") return "note";
  const t = value.trim().toLowerCase();
  return SUPPORTED_TYPES.has(t)
    ? (t as "highlight" | "underline" | "note")
    : "note";
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function normalizePageIndex(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  }
  return undefined;
}

// ── Page placement resolution ───────────────────────────────────────────────

type PageTextGeometry = {
  width: number;
  height: number;
  items: Array<{ str: string; x: number; y: number; width: number; height: number }>;
};

const BASELINE_TOL = 3; // pts — group text items into lines by baseline y

/**
 * Locate `needle` in `text`. Exact match first; otherwise the longest
 * run of consecutive needle-words that appears verbatim (so a passage
 * with math in the middle still anchors on its clean prose).
 * Both strings are already single-space normalized by the caller.
 */
function locateSpan(
  text: string,
  needle: string,
): { start: number; end: number; matched: number; exact: boolean } | null {
  const direct = text.indexOf(needle);
  if (direct >= 0) {
    return { start: direct, end: direct + needle.length, matched: needle.length, exact: true };
  }

  const words = [...needle.matchAll(/\S+/g)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
  }));
  if (!words.length) return null;

  let best: { start: number; end: number; len: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    let j = i;
    let matchStart = text.indexOf(needle.slice(words[i].start, words[i].end));
    if (matchStart < 0) continue;
    while (j + 1 < words.length) {
      const phrase = needle.slice(words[i].start, words[j + 1].end);
      const at = text.indexOf(phrase);
      if (at < 0) break;
      matchStart = at;
      j++;
    }
    const len = words[j].end - words[i].start;
    if (!best || len > best.len) best = { start: matchStart, end: matchStart + len, len };
  }

  // Acceptance is now the caller's job (coverage across pages), not a fixed floor.
  return best ? { start: best.start, end: best.end, matched: best.len, exact: false } : null;
}

/** Chars of the needle that must match to accept a NON-exact placement. */
function minMatchFor(needle: string): number {
  const len = normalizeNeedle(needle).length;
  return Math.max(15, Math.min(Math.round(len * 0.6), 60));
}

/** Strip markdown/LaTeX artefacts so full.md text can match the PDF text layer. */
function normalizeNeedle(s: string): string {
  return s
    .replace(/`+/g, "")
    .replace(/~~/g, "")
    .replace(/\*\*|__|\*|_/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\$[^$]*\$/g, " ")   // inline math → gap (prose still anchors)
    .replace(/\\[a-zA-Z]+/g, " ") // stray LaTeX commands
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Locate `needle` in the page's text-layer geometry and return bounding
 * rects (PDF user space, bottom-left, y-up) suitable for Zotero's
 * `position.rects`, plus ordering metadata.
 */
function resolveTextRects(
  geom: PageTextGeometry,
  needle: string,
): {
  rects: number[][];
  charOffset: number;
  top: number;
  matched: number;
  exact: boolean;
} | null {
  const target = normalizeNeedle(needle);
  if (!target) return null;

  let text = "";
  const charToItem: number[] = [];
  geom.items.forEach((it, i) => {
    const piece = (it.str || "").replace(/\s+/g, " ");
    if (!piece) return;
    if (text && !text.endsWith(" ") && !piece.startsWith(" ")) {
      text += " ";
      charToItem.push(i);
    }
    for (let k = 0; k < piece.length; k++) charToItem.push(i); // UTF-16 units, matches indexOf/length
    text += piece;
  });

  const span = locateSpan(text, target);
  if (!span) return null;

  const covered = new Set<number>();
  for (let c = span.start; c < span.end && c < charToItem.length; c++)
    covered.add(charToItem[c]);
  if (!covered.size) return null;

  const boxes = [...covered]
    .map((i) => {
      const it = geom.items[i];
      const h = it.height || 10;
      return {
        x1: it.x,
        y1: it.y - h * 0.2,
        x2: it.x + it.width,
        y2: it.y + h,
      };
    })
    .sort((a, b) => b.y1 - a.y1 || a.x1 - b.x1);

  const lines: (typeof boxes)[] = [];
  for (const b of boxes) {
    const line = lines.find((l) => Math.abs(l[0].y1 - b.y1) <= BASELINE_TOL);
    if (line) line.push(b);
    else lines.push([b]);
  }
  const rects = lines.map((l) =>
    [
      Math.min(...l.map((b) => b.x1)),
      Math.min(...l.map((b) => b.y1)),
      Math.max(...l.map((b) => b.x2)),
      Math.max(...l.map((b) => b.y2)),
    ].map((n) => Math.round(n * 1000) / 1000),
  );

  const topY = Math.max(...rects.map((r) => r[3]));
  return {
    rects,
    charOffset: span.start,
    top: Math.max(0, Math.round(geom.height - topY)),
    matched: span.matched,
    exact: span.exact,
  };
}

/**
 * Resolve the physical page index and display label for an annotation,
 * reconciling the user-supplied index/label against the PDF's actual
 * page-label map (PDF.js `pageLabels`).
 *
 * `labels` is indexed by 0-based physical page; each entry is the printed
 * label for that page (or `null` if the PDF has no custom labels).
 */
function resolvePagePlacement(
  ann: AnnotationEntry,
  labels: (string | null)[] | null,
): { pageIndex: number; pageLabel?: string } {
  const map = labels ?? [];
  const hasIndex = ann.pageIndex != null && ann.pageIndex >= 0;

  if (hasIndex) {
    const derived = map[ann.pageIndex!] ?? null;
    // If a supplied label disagrees with the map, the incoming index is
    // label-based (off by the offset) — trust the label, reverse-map it.
    if (ann.pageLabel && derived != null && derived !== ann.pageLabel) {
      const physical = map.findIndex((l) => l === ann.pageLabel);
      if (physical >= 0) return { pageIndex: physical, pageLabel: ann.pageLabel };
    }
    return {
      pageIndex: ann.pageIndex!,
      pageLabel: derived ?? ann.pageLabel ?? String(ann.pageIndex! + 1),
    };
  }

  if (ann.pageLabel) {
    const physical = map.findIndex((l) => l === ann.pageLabel);
    if (physical >= 0) return { pageIndex: physical, pageLabel: ann.pageLabel };
  }
  return { pageIndex: 0, pageLabel: ann.pageLabel ?? "1" };
}

// ── Tool definition ──────────────────────────────────────────────────────────

export function createAnnotationTool(
  zoteroGateway: ZoteroGateway,
  pdfPageService: PdfPageService,
): AgentToolDefinition<CreateAnnotationInput, unknown> {
  return {
    spec: {
      name: "annotation_create",
      description:
        "Create PDF annotations (highlights, underlines, or notes) on text " +
        "blocks discovered via paper_read targeted search or fulltext analysis. " +
        "Each annotation references the text, page, and paper context from search " +
        "results.  Batch up to 20 annotations per call.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          paperContext: {
            type: "object",
            description:
              "Paper context reference from paper_read or library_search results. " +
              "Must include itemId and contextItemId.",
            properties: {
              itemId: { type: "number", description: "Zotero item ID of the paper." },
              contextItemId: {
                type: "number",
                description: "PDF attachment item ID used as context source.",
              },
            },
            required: ["itemId", "contextItemId"],
          },
          annotations: {
            type: "array",
            description:
              "Annotations to create. Pass pageIndex from search results; " +
              "if unavailable, the tool falls back to page 0.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["highlight", "underline", "note"],
                  description:
                    "highlight = coloured text highlight, underline = underlined " +
                    "text, note = page-level sticky note with optional comment.",
                },
                text: {
                  type: "string",
                  description:
                    "The exact text passage to annotate (the text from the search result). " +
                    "Required for highlight and underline types.",
                },
                comment: {
                  type: "string",
                  description: "Optional note / comment attached to the annotation.",
                },
                color: {
                  type: "string",
                  description:
                    'Colour label ("yellow","green","blue","red","purple","orange") ' +
                    'or hex ("#FFD700").',
                },
                pageIndex: {
                  type: "number",
                  description:
                    "Zero-based page index where the text appears (from paper_read " +
                    "results).",
                },
                pageLabel: {
                  type: "string",
                  description:
                    "Printed page label (e.g. '42') from paper_read results.",
                },
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
        },
        required: ["paperContext", "annotations"],
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: () => true,
      instruction:
        "Use annotation_create to highlight, underline, or annotate passages. " +
        "You do NOT need page coordinates: the tool locates each passage by its " +
        "verbatim text across the whole document and places it on the correct page. " +
        "If you already have pageIndex/pageLabel from a paper_read targeted search, " +
        "pass them — it's faster and avoids a document scan — but they're optional. " +
        "CRITICAL: pass the `text` field EXACTLY as it appears in the paper_read / " +
        "fulltext result — verbatim characters only. NEVER reformat as LaTeX or " +
        "Markdown math (no \\Delta, k_{...}, ^{}/_{}); if a passage has an equation " +
        "you can't copy verbatim, annotate the clean prose next to it or use a note. " +
        "ALWAYS batch annotations on the same paper into one call. " +
        "Colours: yellow = key finding, green = supporting evidence, blue = methodology, " +
        "red = limitation/contradiction, purple = definition. " +
        "Do NOT call annotation_create for papers without a PDF attachment.",
    },
    presentation: {
      label: "Create Annotations",
      summaries: {
        onCall: "Preparing annotations",
        onPending: "Review annotations before creating",
        onApproved: "Creating annotations",
        onDenied: "Annotations cancelled",
        onSuccess: ({ content }) => {
          const count =
            content && typeof content === "object"
              ? (content as { createdCount?: number }).createdCount
              : undefined;
          return count ? `Created ${count} annotation(s)` : "Annotations created";
        },
      },
    },

    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with paperContext and annotations array");
      }
      if (!validateObject<Record<string, unknown>>(args.paperContext)) {
        return fail("paperContext must be an object with itemId and contextItemId");
      }
      const paperContext = args.paperContext as unknown as PaperContextRef;
      if (!normalizePositiveInt(paperContext.itemId)) {
        return fail("paperContext.itemId is required (number)");
      }
      if (!normalizePositiveInt(paperContext.contextItemId)) {
        return fail("paperContext.contextItemId is required (number)");
      }
      if (!Array.isArray(args.annotations) || !args.annotations.length) {
        return fail("annotations must be a non-empty array");
      }
      if (args.annotations.length > MAX_ANNOTATIONS) {
        return fail(
          `Too many annotations (${args.annotations.length}). Maximum is ${MAX_ANNOTATIONS} per call.`,
        );
      }

      const annotations: AnnotationEntry[] = [];
      for (let i = 0; i < (args.annotations as unknown[]).length; i++) {
        const entry = (args.annotations as unknown[])[i];
        if (!validateObject<Record<string, unknown>>(entry)) {
          return fail(`annotations[${i}] must be an object`);
        }
        const type = normalizeType(entry.type);
        const text = normalizeOptionalString(entry.text);
        const comment = normalizeOptionalString(entry.comment);
        const color = normalizeOptionalString(entry.color);
        const pageIndex = normalizePageIndex(entry.pageIndex);
        const pageLabel = normalizeOptionalString(entry.pageLabel);

        if ((type === "highlight" || type === "underline") && !text) {
          return fail(
            `annotations[${i}]: text is required for highlight / underline annotations`,
          );
        }

        annotations.push({ type, text, comment, color, pageIndex, pageLabel });
      }

      return ok<CreateAnnotationInput>({
        paperContext,
        annotations,
      });
    },

    createPendingAction: (input, context) => {
      void context;
      const paperContext = input.paperContext;
      const annotationCount = input.annotations.length;
      const typeSummary = input.annotations
        .map((a) => a.type)
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .join(", ");

      const annotationRows = input.annotations.map((ann, i) => ({
        id: `ann-${i}`,
        label: `${ann.type}${ann.color ? ` (${ann.color})` : ""}`,
        description: [
          ann.text ? `"${ann.text.slice(0, 80)}${ann.text.length > 80 ? "…" : ""}"` : "",
          ann.comment ? `Comment: ${ann.comment.slice(0, 80)}` : "",
          `Page: ${ann.pageLabel || (ann.pageIndex != null ? `${ann.pageIndex + 1}` : ann.text ? "auto (located from text on create)" : "1 (default)")}`,
        ]
          .filter(Boolean)
          .join(" | "),
        checked: true,
      }));

      return {
        toolName: "annotation_create",
        mode: "review" as const,
        title: `Create ${annotationCount} Annotation${annotationCount === 1 ? "" : "s"}`,
        description: [
          `Paper: ${formatPaperSourceLabel(paperContext)}`,
          `Types: ${typeSummary}`,
        ].join(" · "),
        confirmLabel: "Create Annotations",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: "selectedAnnotations",
            label: "Annotations to create",
            items: annotationRows,
          },
          {
            type: "textarea" as const,
            id: "annotationsJson",
            label: "Annotations JSON",
            value: JSON.stringify(
              input.annotations.map((a) => ({
                type: a.type,
                text: a.text,
                comment: a.comment,
                color: a.color,
                pageIndex: a.pageIndex,
                pageLabel: a.pageLabel,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },

    applyConfirmation: (input, resolutionData) => {
      const data = (resolutionData ?? {}) as Record<string, unknown>;
      let annotations = input.annotations;

      // Honour the editable JSON textarea if the user modified it.
      if (typeof data.annotationsJson === "string" && data.annotationsJson.trim()) {
        try {
          const parsed = JSON.parse(data.annotationsJson);
          if (Array.isArray(parsed)) annotations = parsed;
        } catch {
          return fail("Annotations JSON is not valid JSON");
        }
      }

      // Honour the checklist toggles.
      if (Array.isArray(data.selectedAnnotations)) {
        const keep = new Set(data.selectedAnnotations.map(String));
        annotations = annotations.filter((_, i) => keep.has(`ann-${i}`));
      }

      if (!annotations.length) return fail("No annotations selected");

      return ok({ ...input, annotations });
    },

    execute: async (input, context) => {
      const paperContext = input.paperContext;
      const itemId = normalizePositiveInt(paperContext.itemId)!;
      const contextItemId = normalizePositiveInt(paperContext.contextItemId);

      // Resolve the PDF's embedded page-label map so we can reconcile
      // physical page indices with printed labels.
      let pageLabels: (string | null)[] | null = null;
      if (contextItemId) {
        try {
          pageLabels = await pdfPageService.getPageLabels(contextItemId);
        } catch {
          pageLabels = null;
        }
      }

      const created: Array<{
        annotationId: number;
        type: string;
        pageLabel?: string;
        undoDescription: string;
        placedPrecisely: boolean;
        degraded: boolean;
      }> = [];

      // Cache text-layer geometry per page to avoid re-opening the reader.
      const geometryByPage = new Map<number, PageTextGeometry | null>();
      const geometryFor = async (pageIdx: number) => {
        if (!contextItemId) return null;
        if (!geometryByPage.has(pageIdx)) {
          try {
            geometryByPage.set(
              pageIdx,
              await pdfPageService.getPageTextGeometry(contextItemId, pageIdx),
            );
          } catch {
            geometryByPage.set(pageIdx, null);
          }
        }
        return geometryByPage.get(pageIdx)!;
      };

      // Total page count — needed to scan the document when the agent gave no
      // (reliable) page, e.g. it annotated straight from a full-text / full.md read.
      let cachedPageCount: number | null = null;
      const resolvePageCount = async (): Promise<number> => {
        if (cachedPageCount != null) return cachedPageCount;
        if (pageLabels?.length) return (cachedPageCount = pageLabels.length);
        const svc = pdfPageService as unknown as {
          getPageCount?: (id: number) => Promise<number> | number;
        };
        if (contextItemId && typeof svc.getPageCount === "function") {
          try {
            const n = await svc.getPageCount(contextItemId);
            if (Number.isFinite(n) && n > 0) {
              return (cachedPageCount = Math.floor(n));
            }
          } catch { /* fall through to probe */ }
        }
        return (cachedPageCount = 0); // unknown → probe mode
      };

      // First page whose text layer contains `needle`, with anchoring rects.
      // Exact matches win immediately; partial matches select the single best
      // across ALL pages (so a short echo in the abstract can't beat the real page).
      const locateAcrossPages = async (needle: string) => {
        const known = await resolvePageCount();
        const cap = known > 0 ? known : 64;
        const minMatch = minMatchFor(needle);
        let sawContent = false;
        let nullRun = 0;
        let best:
          | { pageIndex: number; located: NonNullable<ReturnType<typeof resolveTextRects>> }
          | null = null;

        for (let p = 0; p < cap; p++) {
          const geom = await geometryFor(p);
          if (geom === null) {
            if (known === 0 && sawContent && ++nullRun >= 2) break;
            continue;
          }
          sawContent = true;
          nullRun = 0;
          if (!geom.items.length) continue;

          const hit = resolveTextRects(geom, needle);
          if (!hit) continue;

          // Exact, verbatim match → unambiguous; take it and stop scanning.
          if (hit.exact) return { pageIndex: p, located: hit };

          // Otherwise keep the single best partial across ALL pages.
          if (!best || hit.matched > best.located.matched) {
            best = { pageIndex: p, located: hit };
          }
        }

        return best && best.located.matched >= minMatch ? best : null;
      };

      for (const ann of input.annotations) {
        let { pageIndex, pageLabel } = resolvePagePlacement(ann, pageLabels);
        const hadExplicitPage = ann.pageIndex != null || Boolean(ann.pageLabel);

        let rects: number[][] | undefined;
        let charOffset: number | undefined;
        let topOffset: number | undefined;
        let type = ann.type;
        let text = ann.text;
        let comment = ann.comment;

        if (ann.text) {
          let located: ReturnType<typeof resolveTextRects> = null;
          const minMatch = minMatchFor(ann.text);

          // 1) Fast path: try the supplied page — but only trust a STRONG match.
          if (hadExplicitPage) {
            const geom = await geometryFor(pageIndex);
            const hit = geom ? resolveTextRects(geom, ann.text) : null;
            if (hit && (hit.exact || hit.matched >= minMatch)) located = hit;
          }

          // 2) Fallback: scan the whole document for the strongest match.
          if (!located) {
            const hit = await locateAcrossPages(ann.text);
            if (hit) {
              pageIndex = hit.pageIndex;
              pageLabel =
                pageLabels?.[hit.pageIndex] ??
                (hadExplicitPage ? pageLabel : String(hit.pageIndex + 1));
              located = hit.located;
            }
          }

          if (located) {
            rects = located.rects;
            charOffset = located.charOffset;
            topOffset = located.top;
          } else if (ann.type === "highlight" || ann.type === "underline") {
            const quoted =
              ann.text.length > 300 ? `${ann.text.slice(0, 300)}…` : ann.text;
            type = "note";
            text = undefined; // a note carries its content in the comment
            comment = [
              ann.comment,
              `⚠ Couldn't anchor "${quoted}" — its text wasn't found on any page's text layer (scanned/image page, or reformatted text). Left as a page note.`,
            ]
              .filter(Boolean)
              .join("\n\n");
          }
        }

        const result = await zoteroGateway.createAnnotation({
          itemId,
          contextItemId: contextItemId ?? undefined,
          type,
          text,
          comment,
          color: ann.color,
          pageIndex,
          pageLabel,
          rects,
          charOffset,
          topOffset,
        });

        created.push({
          annotationId: result.annotationId,
          type: result.type,
          pageLabel: result.pageLabel,
          undoDescription: `${result.type} annotation on page ${result.pageLabel || "?"}`,
          placedPrecisely: Array.isArray(rects) && rects.length > 0,
          degraded:
            (ann.type === "highlight" || ann.type === "underline") &&
            type === "note",
        });
      }

      // ── Undo / redo (snapshot-based, symmetric with annotation_delete) ──
      // Undo removes the created annotations via the shared gateway path,
      // capturing snapshots so the removal can be restored (redo). The pair
      // makes both directions idempotent.
      let liveIds: number[] = created
        .map((entry) => entry.annotationId)
        .filter((id): id is number => typeof id === "number" && id > 0);
      let undoSnapshots: AnnotationSnapshot[] = [];

      const { revert, restore } = createUndoRedoPair({
        undo: async () => {
          if (!liveIds.length) return;
          const { snapshots } = await zoteroGateway.deleteAnnotations({
            annotationIds: liveIds,
          });
          undoSnapshots = snapshots; // retained so redo can restore
          liveIds = [];
        },
        redo: async () => {
          if (!undoSnapshots.length) return;
          const { results } = await zoteroGateway.restoreAnnotations({
            snapshots: undoSnapshots,
          });
          liveIds = results
            .map((r) => r.newAnnotationId)
            .filter((id): id is number => typeof id === "number" && id > 0);
        },
      });

      pushUndoEntry(context.request.conversationKey, {
        id: `undo-annotation_create-${Date.now()}`,
        toolName: "annotation_create",
        description: `Undo ${created.length} annotation${created.length === 1 ? "" : "s"} on ${formatPaperCitationLabel(paperContext)}`,
        revert,
        restore,
      });

      return {
        kind: "result" as const,
        content: {
          createdCount: created.length,
          preciseCount: created.filter((c) => c.placedPrecisely).length,
          degradedCount: created.filter((c) => c.degraded).length,
          annotations: created,
          paperContext,
        },
      };
    },

    buildFollowupMessage: async (result, _context) => {
      const content =
        result.content && typeof result.content === "object"
          ? (result.content as {
              createdCount?: number;
              preciseCount?: number;
              degradedCount?: number;
            })
          : null;
      const count = content?.createdCount || 0;
      if (!count) return null;
      const precise = content?.preciseCount || 0;
      const degraded = content?.degradedCount || 0;
      const parts = [
        `Created ${count} annotation${count === 1 ? "" : "s"} on the paper's PDF.`,
      ];
      if (precise) parts.push(`${precise} anchored to the located text.`);
      if (degraded) {
        parts.push(
          `${degraded} couldn't be located on any page and ${degraded === 1 ? "was" : "were"} added as ${degraded === 1 ? "a page note" : "page notes"}.`,
        );
      }
      return { role: "assistant" as const, content: parts.join(" ") };
    },
  };
}
