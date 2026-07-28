/**
 * Tool for finding PDF annotations (highlights, underlines, notes)
 * across the Zotero library with flexible filtering.
 *
 * Returns a flat list of matching annotations whose IDs can be passed
 * directly to annotation_update or annotation_delete.
 */
import type { ZoteroGateway, PaperAnnotationRecord } from "../../services/zoteroGateway";
import { resolveAnnotationColor } from "../../services/zoteroGateway";
import type { AgentToolDefinition } from "../../types";
import type { PaperContextRef } from "../../../shared/types";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  normalizeToolPaperContext,
  PAPER_CONTEXT_REF_SCHEMA,
} from "../shared";

// ── Types ────────────────────────────────────────────────────────────────────

type AnnotationFindFilters = {
  /** Match only annotations of this type. */
  annotationType?: "highlight" | "underline" | "note";
  /** Match annotations on this 0-based page (compares against numeric page labels: pageIndex 0 matches label "1"). */
  pageIndex?: number;
  /** Match annotations with this exact printed page label (e.g. "42", "xiv"). */
  pageLabel?: string;
  /** Match annotations of this colour — accepts name ("yellow") or hex ("#ffd400"). */
  color?: string;
  /** If true, only annotations that have a comment. If false, only annotations without a comment. */
  hasComment?: boolean;
  /** Case-insensitive substring match in the annotation comment. */
  commentContains?: string;
  /** Case-insensitive substring match in the annotation text. */
  textContains?: string;
};

type AnnotationFindInput = {
  /** Optional: restrict search to these papers. Omit to search the entire library. */
  paperContexts?: PaperContextRef[];
  /** Filters to apply. All filters are ANDed. Omit all to return every annotation. */
  filters?: AnnotationFindFilters;
  /** Maximum total annotations to return across all papers. Default 200, max 500. */
  limit?: number;
  /** Maximum annotations to fetch per paper. Default 100, max 200. */
  maxPerPaper?: number;
};

type AnnotationFindRecord = PaperAnnotationRecord & {
  itemId: number;
  contextItemId: number;
  paperTitle: string;
};

type AnnotationFindResult = {
  annotations: AnnotationFindRecord[];
  total: number;
  truncated: boolean;
};

const MAX_TOTAL_LIMIT = 500;
const DEFAULT_TOTAL_LIMIT = 200;
const MAX_PER_PAPER = 200;
const DEFAULT_PER_PAPER = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeAnnotationType(
  value: unknown,
): "highlight" | "underline" | "note" | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim().toLowerCase();
  return t === "highlight" || t === "underline" || t === "note"
    ? (t as "highlight" | "underline" | "note")
    : undefined;
}

function normalizePageIndex(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function normalizeColorFilter(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return resolveAnnotationColor(value.trim());
}

function matchesFilters(
  record: PaperAnnotationRecord,
  filters: AnnotationFindFilters,
): boolean {
  // annotationType
  if (filters.annotationType && record.type !== filters.annotationType) {
    return false;
  }

  // pageIndex — compare 0-based index against numeric page labels
  if (filters.pageIndex != null) {
    const labelNum = parseInt(record.pageLabel || "", 10);
    if (!Number.isFinite(labelNum)) return false;
    // Zotero page labels are typically 1-based
    if (labelNum !== filters.pageIndex + 1) return false;
  }

  // pageLabel — exact string match
  if (filters.pageLabel !== undefined && record.pageLabel !== filters.pageLabel) {
    return false;
  }

  // color — normalized hex comparison
  if (filters.color !== undefined) {
    const recordColor = resolveAnnotationColor(record.color);
    if (recordColor !== filters.color) return false;
  }

  // hasComment
  if (filters.hasComment === true) {
    if (!record.comment) return false;
  } else if (filters.hasComment === false) {
    if (record.comment) return false;
  }

  // commentContains — case-insensitive substring
  if (filters.commentContains !== undefined) {
    const haystack = (record.comment || "").toLowerCase();
    if (!haystack.includes(filters.commentContains.toLowerCase())) return false;
  }

  // textContains — case-insensitive substring
  if (filters.textContains !== undefined) {
    const haystack = (record.text || "").toLowerCase();
    if (!haystack.includes(filters.textContains.toLowerCase())) return false;
  }

  return true;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export function createAnnotationFindTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<AnnotationFindInput, AnnotationFindResult> {
  return {
    spec: {
      name: "annotation_find",
      description:
        "Search and filter PDF annotations (highlights, underlines, notes) " +
        "across your Zotero library or specific papers. " +
        "Filter by type, page, colour, comment presence/content, and text content. " +
        "Returns a flat list of matching annotations whose IDs can be fed to " +
        "annotation_update or annotation_delete.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          paperContexts: {
            type: "array",
            items: PAPER_CONTEXT_REF_SCHEMA,
            description:
              "Optional: restrict search to these papers. Omit to search the entire library.",
          },
          filters: {
            type: "object",
            additionalProperties: false,
            description:
              "Filters to apply. All provided filters are ANDed together. Omit all to return every annotation.",
            properties: {
              annotationType: {
                type: "string",
                enum: ["highlight", "underline", "note"],
                description: "Match only annotations of this type.",
              },
              pageIndex: {
                type: "number",
                description:
                  "Match annotations on this 0-based page (compares against numeric page labels: pageIndex 0 matches label '1'). Non-numeric labels (e.g. 'xiv') will not match.",
              },
              pageLabel: {
                type: "string",
                description:
                  "Match annotations with this exact printed page label (e.g. '42', 'xiv').",
              },
              color: {
                type: "string",
                description:
                  "Match annotations of this colour. Accepts colour name (e.g. 'yellow') or hex (e.g. '#ffd400').",
              },
              hasComment: {
                type: "boolean",
                description:
                  "If true, only annotations that have a comment. If false, only annotations without a comment.",
              },
              commentContains: {
                type: "string",
                description:
                  "Case-insensitive substring match in the annotation comment.",
              },
              textContains: {
                type: "string",
                description:
                  "Case-insensitive substring match in the annotation text.",
              },
            },
          },
          limit: {
            type: "number",
            description: `Maximum total annotations to return across all papers. Default ${DEFAULT_TOTAL_LIMIT}, max ${MAX_TOTAL_LIMIT}.`,
          },
          maxPerPaper: {
            type: "number",
            description: `Maximum annotations to fetch per paper. Default ${DEFAULT_PER_PAPER}, max ${MAX_PER_PAPER}.`,
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },

    presentation: {
      label: "Find Annotations",
      summaries: {
        onCall: "Searching annotations",
        onSuccess: ({ content }) => {
          if (!content || typeof content !== "object") return "Annotations found";
          const result = content as AnnotationFindResult;
          const suffix = result.truncated
            ? ` (showing ${result.annotations.length} of ${result.total})`
            : "";
          return result.annotations.length === 0
            ? "No annotations matched"
            : `Found ${result.annotations.length} annotation${result.annotations.length === 1 ? "" : "s"}${suffix}`;
        },
      },
    },

    // ── Validation ───────────────────────────────────────────────────────

    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object. Optionally provide paperContexts, filters, limit, and maxPerPaper.",
        );
      }

      // Normalize paperContexts
      const paperContexts = Array.isArray(args.paperContexts)
        ? (args.paperContexts as unknown[])
            .map((entry) =>
              validateObject<Record<string, unknown>>(entry)
                ? normalizeToolPaperContext(entry)
                : null,
            )
            .filter((ctx): ctx is PaperContextRef => Boolean(ctx))
        : undefined;

      // Normalize filters
      const rawFilters = validateObject<Record<string, unknown>>(args.filters)
        ? (args.filters as Record<string, unknown>)
        : {};
      const filters: AnnotationFindFilters = {};
      let hasFilter = false;

      const annType = normalizeAnnotationType(rawFilters.annotationType);
      if (annType) {
        filters.annotationType = annType;
        hasFilter = true;
      }

      const pageIdx = normalizePageIndex(rawFilters.pageIndex);
      if (pageIdx != null) {
        filters.pageIndex = pageIdx;
        hasFilter = true;
      }

      const pageLabel = normalizeOptionalString(rawFilters.pageLabel);
      if (pageLabel !== undefined) {
        filters.pageLabel = pageLabel;
        hasFilter = true;
      }

      const color = normalizeColorFilter(rawFilters.color);
      if (color !== undefined) {
        filters.color = color;
        hasFilter = true;
      }

      if (rawFilters.hasComment === true || rawFilters.hasComment === "true") {
        filters.hasComment = true;
        hasFilter = true;
      } else if (rawFilters.hasComment === false || rawFilters.hasComment === "false") {
        filters.hasComment = false;
        hasFilter = true;
      }

      const commentContains = normalizeOptionalString(rawFilters.commentContains);
      if (commentContains !== undefined) {
        filters.commentContains = commentContains;
        hasFilter = true;
      }

      const textContains = normalizeOptionalString(rawFilters.textContains);
      if (textContains !== undefined) {
        filters.textContains = textContains;
        hasFilter = true;
      }

      // Normalize limit
      let limit = normalizePositiveInt(args.limit) || DEFAULT_TOTAL_LIMIT;
      if (limit > MAX_TOTAL_LIMIT) limit = MAX_TOTAL_LIMIT;

      // Normalize maxPerPaper
      let maxPerPaper = normalizePositiveInt(args.maxPerPaper) || DEFAULT_PER_PAPER;
      if (maxPerPaper > MAX_PER_PAPER) maxPerPaper = MAX_PER_PAPER;

      return ok<AnnotationFindInput>({
        paperContexts:
          paperContexts && paperContexts.length > 0 ? paperContexts : undefined,
        filters: hasFilter ? filters : undefined,
        limit,
        maxPerPaper,
      });
    },

    // ── Execution ───────────────────────────────────────────────────────

    execute: async (input, context) => {
      const filters = input.filters || {};
      const limit = input.limit || DEFAULT_TOTAL_LIMIT;
      const maxPerPaper = input.maxPerPaper || DEFAULT_PER_PAPER;

      const Zotero = (globalThis as any).Zotero;
      if (!Zotero?.Items) {
        throw new Error("Zotero API not available");
      }

      const results: AnnotationFindRecord[] = [];
      let matchedTotal = 0;

      const clean = (value: unknown): string =>
        `${value ?? ""}`.replace(/\s+/g, " ").trim();

      // Build a record for ANY annotation type — including image / ink
      // annotations that carry neither text nor a comment. (The old gateway
      // path dropped those, so they were unfindable.)
      const buildAnnotationRecord = (annotation: any): PaperAnnotationRecord => {
        const rawText = clean(annotation.annotationText || "");
        const rawComment =
          clean(annotation.annotationComment || "") || undefined;
        return {
          annotationId: annotation.id,
          type: clean(annotation.annotationType || "") || "highlight",
          text:
            rawText.length > 500 ? `${rawText.slice(0, 500)}\u2026` : rawText,
          comment:
            rawComment && rawComment.length > 500
              ? `${rawComment.slice(0, 500)}\u2026`
              : rawComment,
          color: clean(annotation.annotationColor || "") || undefined,
          pageLabel: clean(annotation.annotationPageLabel || "") || undefined,
        };
      };

      // PDF attachment that owns an annotation (needed by update/delete).
      const resolveContextItemId = (
        annotationId: number,
        fallbackItemId: number,
      ): number => {
        const annotation = Zotero.Items.get(annotationId);
        const attachmentId = Number(annotation?.parentID);
        return Number.isFinite(attachmentId) && attachmentId > 0
          ? attachmentId
          : fallbackItemId;
      };

      if (input.paperContexts && input.paperContexts.length > 0) {
        // Scoped search: descend from each requested paper into its PDF
        // attachments and keep EVERY annotation, regardless of type.
        const collectPaperAnnotations = (
          rawItemId: number,
          cap: number,
        ): PaperAnnotationRecord[] => {
          const item = Zotero.Items.get(rawItemId);
          const regular = item?.isRegularItem?.()
            ? item
            : item?.parentID
              ? Zotero.Items.get(item.parentID)
              : null;
          const paperItem = regular?.isRegularItem?.() ? regular : null;
          if (!paperItem) return [];
          const out: PaperAnnotationRecord[] = [];
          const attachmentIds: number[] = paperItem.getAttachments?.() || [];
          for (const attId of attachmentIds) {
            if (out.length >= cap) break;
            const att = Zotero.Items.get(attId);
            if (
              !att?.isAttachment?.() ||
              att.attachmentContentType !== "application/pdf"
            ) {
              continue;
            }
            const annIds: number[] = att.getAnnotations?.() || [];
            for (const annId of annIds) {
              if (out.length >= cap) break;
              const annotation = Zotero.Items.get(annId);
              if (!annotation?.isAnnotation?.()) continue;
              out.push(buildAnnotationRecord(annotation));
            }
          }
          return out;
        };

        for (const paperContext of input.paperContexts) {
          const records = collectPaperAnnotations(
            paperContext.itemId,
            maxPerPaper,
          );
          for (const record of records) {
            if (!matchesFilters(record, filters)) continue;
            matchedTotal++;
            if (results.length < limit) {
              results.push({
                ...record,
                itemId: paperContext.itemId,
                contextItemId: resolveContextItemId(
                  record.annotationId,
                  paperContext.itemId,
                ),
                paperTitle: paperContext.title || `Item ${paperContext.itemId}`,
              });
            }
          }
        }
      } else {
        // Whole-library search. Annotations are NOT top-level items and do not
        // hang off regular items — they live one level below the PDF attachment
        // (regular item -> PDF attachment -> annotation). Enumerating only
        // top-level items never reaches them, which is why this path returned
        // { annotations: [], total: 0 }. Enumerate ALL items (onlyTopLevel =
        // false includes child annotations) and keep them.
        const libraryID = zoteroGateway.resolveLibraryID({
          request: context.request,
          item: context.item,
        });
        if (!libraryID) {
          throw new Error(
            "No active Zotero library available for annotation search",
          );
        }

        let allItems: any[] = [];
        try {
          allItems = await Zotero.Items.getAll(libraryID, false, false, false);
        } catch (error) {
          throw new Error(
            `Failed to enumerate library items for annotation search: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        // Resolve + cache the owning paper for each PDF attachment; cap per paper.
        const paperByAttachment = new Map<
          number,
          { itemId: number; title: string }
        >();
        const perPaperCount = new Map<number, number>();
        const resolvePaper = (
          attachment: any,
        ): { itemId: number; title: string } => {
          const cached = paperByAttachment.get(attachment.id);
          if (cached) return cached;
          const parent = attachment.parentID
            ? Zotero.Items.get(attachment.parentID)
            : null;
          const paperItem = parent?.isRegularItem?.() ? parent : null;
          const resolved = paperItem
            ? {
                itemId: paperItem.id,
                title:
                  clean(paperItem.getField?.("title")) ||
                  clean(paperItem.getDisplayTitle?.()) ||
                  `Item ${paperItem.id}`,
              }
            : {
                itemId: attachment.id,
                title:
                  clean(attachment.getField?.("title")) ||
                  clean(attachment.attachmentFilename) ||
                  `Attachment ${attachment.id}`,
              };
          paperByAttachment.set(attachment.id, resolved);
          return resolved;
        };

        for (const annotation of allItems) {
          if (!annotation?.isAnnotation?.()) continue;

          const attachment = annotation.parentID
            ? Zotero.Items.get(annotation.parentID)
            : null;
          if (
            !attachment?.isAttachment?.() ||
            attachment.attachmentContentType !== "application/pdf"
          ) {
            continue;
          }

          const paper = resolvePaper(attachment);
          const used = perPaperCount.get(paper.itemId) || 0;
          if (used >= maxPerPaper) continue;
          perPaperCount.set(paper.itemId, used + 1);

          const record = buildAnnotationRecord(annotation);
          if (!matchesFilters(record, filters)) continue;
          matchedTotal++;
          if (results.length < limit) {
            results.push({
              ...record,
              itemId: paper.itemId,
              contextItemId: attachment.id,
              paperTitle: paper.title,
            });
          }
        }
      }

      return {
        kind: "result" as const,
        content: {
          annotations: results,
          total: matchedTotal,
          truncated: matchedTotal > results.length,
        },
      };
    },
  };
}
