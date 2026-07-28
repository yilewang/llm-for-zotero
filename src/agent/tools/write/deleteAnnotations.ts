/**
 * Tool for deleting PDF annotations (highlights, underlines, notes)
 * from papers in the Zotero library.
 */
import type { ZoteroGateway, AnnotationSnapshot } from "../../services/zoteroGateway";
import type { AgentToolDefinition } from "../../types";
import type { PaperContextRef } from "../../../shared/types";
import { pushUndoEntry, createUndoRedoPair } from "../../store/undoStore";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  normalizePositiveIntArray,
} from "../shared";
import {
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";

// ── Types ────────────────────────────────────────────────────────────────────

type DeleteAnnotationsInput = {
  paperContext: PaperContextRef;
  /** Explicit annotation IDs to delete. Takes precedence over filters. */
  annotationIds?: number[];
  /** Delete only annotations of this type. Omit to delete all types. */
  annotationType?: "highlight" | "underline" | "note";
  /** Delete only annotations on this 0-based page. Omit to delete from all pages. */
  pageIndex?: number;
};

const MAX_ANNOTATIONS = 100;

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

// ── Tool definition ──────────────────────────────────────────────────────────

export function createDeleteAnnotationsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<DeleteAnnotationsInput, unknown> {
  return {
    spec: {
      name: "annotation_delete",
      description:
        "Delete PDF annotations (highlights, underlines, notes) from a paper. " +
        "Delete specific annotation IDs or filter by type/page. " +
        "Batch up to 100 annotations per call.",
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
          annotationIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Explicit annotation IDs to delete. When provided, type and pageIndex filters are ignored.",
          },
          annotationType: {
            type: "string",
            enum: ["highlight", "underline", "note"],
            description:
              "Delete only annotations of this type. Omit to match all types.",
          },
          pageIndex: {
            type: "number",
            description:
              "Delete only annotations on this 0-based page. Omit to match all pages.",
          },
        },
        required: ["paperContext"],
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: () => true,
      instruction:
        "Use annotation_delete to remove PDF annotations created earlier " +
        "via annotation_create. " +
        "WORKFLOW: when the user asks to delete or clean up annotations, " +
        "first call annotation_find to list what exists — it returns each " +
        "annotation's annotationId along with the itemId and contextItemId you " +
        "need to build paperContext. Then call annotation_delete with that " +
        "paperContext and the specific annotationIds to remove. " +
        "Use annotationType to delete all annotations of one kind (e.g. " +
        "clean up every note while keeping highlights). " +
        "Use pageIndex to target a single page. " +
        "Only omit all filters to wipe every annotation on a paper — and " +
        "ALWAYS confirm with the user before doing so. " +
        "Do NOT call annotation_delete without first inspecting what exists.",
    },

    presentation: {
      label: "Delete Annotations",
      summaries: {
        onCall: "Preparing to delete annotations",
        onPending: "Review annotations to delete",
        onApproved: "Deleting annotations",
        onDenied: "Annotation deletion cancelled",
        onSuccess: ({ content }) => {
          const count =
            content && typeof content === "object"
              ? (content as { deletedCount?: number }).deletedCount
              : undefined;
          return count ? `Deleted ${count} annotation(s)` : "Annotations deleted";
        },
      },
    },

    // ── Validation ──────────────────────────────────────────────────────

    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with paperContext. " +
            "Optionally provide annotationIds, annotationType, or pageIndex.",
        );
      }
      if (!validateObject<Record<string, unknown>>(args.paperContext)) {
        return fail("paperContext must be an object with itemId and contextItemId");
      }
      const paperContext = args.paperContext as unknown as PaperContextRef;
      if (!normalizePositiveInt(paperContext.itemId)) {
        return fail("paperContext.itemId is required (number)");
      }

      const annotationIds = normalizePositiveIntArray(args.annotationIds);
      const annotationType = normalizeAnnotationType(args.annotationType);
      const pageIndex =
        args.pageIndex != null && Number.isFinite(args.pageIndex as number)
          ? Math.floor(args.pageIndex as number)
          : undefined;

      if (annotationIds && annotationIds.length > MAX_ANNOTATIONS) {
        return fail(
          `Too many annotation IDs (${annotationIds.length}). Maximum is ${MAX_ANNOTATIONS}.`,
        );
      }

      return ok<DeleteAnnotationsInput>({
        paperContext,
        annotationIds: annotationIds?.length ? annotationIds : undefined,
        annotationType,
        pageIndex: pageIndex != null && pageIndex >= 0 ? pageIndex : undefined,
      });
    },

    // ── Confirmation card ───────────────────────────────────────────────

    createPendingAction: (input, context) => {
      void context;
      const paperContext = input.paperContext;

      const descriptionParts: string[] = [
        `Paper: ${formatPaperSourceLabel(paperContext)}`,
      ];
      if (input.annotationIds?.length) {
        descriptionParts.push(`Deleting ${input.annotationIds.length} specified annotation(s)`);
      } else {
        const filters: string[] = [];
        if (input.annotationType) filters.push(`type: ${input.annotationType}`);
        if (input.pageIndex != null) filters.push(`page ${input.pageIndex + 1}`);
        descriptionParts.push(
          filters.length
            ? `Deleting ALL annotations matching: ${filters.join(", ")}`
            : "Deleting ALL annotations on this paper",
        );
      }

      return {
        toolName: "annotation_delete",
        mode: "review" as const,
        title: "Delete Annotations",
        description: descriptionParts.join(" · "),
        confirmLabel: "Delete Annotations",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "textarea" as const,
            id: "deleteSummary",
            label: "Summary",
            value: [
              descriptionParts.join("\n"),
              input.annotationIds?.length
                ? `Annotation IDs: ${input.annotationIds.join(", ")}`
                : input.annotationType
                  ? `Type filter: ${input.annotationType}`
                  : "No type filter",
              input.pageIndex != null
                ? `Page filter: ${input.pageIndex + 1}`
                : "All pages",
            ].join("\n"),
          },
        ],
      };
    },

    applyConfirmation: (input, _resolutionData) => {
      return ok(input);
    },

    // ── Execution ───────────────────────────────────────────────────────

    execute: async (input, context) => {
      const paperContext = input.paperContext;
      const itemId = normalizePositiveInt(paperContext.itemId)!;

      const Zotero = (globalThis as any).Zotero;
      if (!Zotero?.Items) {
        throw new Error("Zotero API not available");
      }

      // Collect candidate annotation IDs.
      let candidateIds: number[] = [];
      if (input.annotationIds?.length) {
        // Explicit IDs: delete directly, independent of paperContext.
        candidateIds = input.annotationIds;
      } else {
        // No IDs: enumerate the paper's PDF annotations, so we need the item.
        const parentItem = Zotero.Items.get(itemId);
        if (!parentItem) {
          throw new Error(`Item not found: ${itemId}`);
        }
        const regularItem = parentItem.isRegularItem?.()
          ? parentItem
          : Zotero.Items.get(parentItem.parentID);
        if (!regularItem?.isRegularItem?.()) {
          throw new Error(`Could not resolve item to a regular item: ${itemId}`);
        }
        const attachmentIds: number[] = regularItem.getAttachments?.() || [];
        for (const attId of attachmentIds) {
          const att = Zotero.Items.get(attId);
          if (!att?.isAttachment?.()) continue;
          if (att.attachmentContentType !== "application/pdf") continue;
          const annIds: number[] =
            (att as unknown as { getAnnotations?: () => number[] }).getAnnotations?.() || [];
          candidateIds.push(...annIds);
        }
      }

      if (!candidateIds.length) {
        return {
          kind: "result" as const,
          content: { deletedCount: 0, results: [], paperContext },
        };
      }

      // Apply filters on the resolved candidate list before passing to gateway.
      const filtered: number[] = [];
      for (const annotationId of candidateIds) {
        const annotation = Zotero.Items.get(annotationId);
        if (!annotation?.isAnnotation?.()) continue;

        if (
          input.annotationType &&
          (annotation as any).annotationType !== input.annotationType
        ) {
          continue;
        }

        if (input.pageIndex != null) {
          const pos = (annotation as any).annotationPosition;
          let annPageIndex: number | undefined;
          try {
            annPageIndex = typeof pos === "string" ? JSON.parse(pos)?.pageIndex : undefined;
          } catch { /* ignore */ }
          if (annPageIndex !== input.pageIndex) continue;
        }

        filtered.push(annotationId);
      }

      if (!filtered.length) {
        return {
          kind: "result" as const,
          content: { deletedCount: 0, results: [], paperContext },
        };
      }

      const deleteResult = await zoteroGateway.deleteAnnotations({
        annotationIds: filtered,
      });
      const { deletedCount, results } = deleteResult;
      let snaps: AnnotationSnapshot[] = deleteResult.snapshots;
      let liveIds: number[] = [];

      if (snaps.length) {
        const lossy = snaps.filter((s) => s.lossy).length;
        const { revert, restore } = createUndoRedoPair({
          undo: async () => {
            if (!snaps.length) return;
            const { results: restoreResults } =
              await zoteroGateway.restoreAnnotations({ snapshots: snaps });
            liveIds = restoreResults
              .map((r) => r.newAnnotationId)
              .filter((id): id is number => typeof id === "number" && id > 0);
          },
          redo: async () => {
            if (!liveIds.length) return;
            const reDelete = await zoteroGateway.deleteAnnotations({
              annotationIds: liveIds,
            });
            snaps = reDelete.snapshots;
            liveIds = [];
          },
        });

        pushUndoEntry(context.request.conversationKey, {
          id: `undo-annotation_delete-${Date.now()}`,
          toolName: "annotation_delete",
          description:
            `Restore ${snaps.length} deleted annotation${snaps.length === 1 ? "" : "s"}` +
            (lossy
              ? ` (${lossy} image annotation${lossy === 1 ? "" : "s"} will return without its image)`
              : ""),
          revert,
          restore,
        });
      }

      return {
        kind: "result" as const,
        content: {
          deletedCount,
          restorableCount: snaps.length,
          results,
          paperContext,
        },
      };
    },

    buildFollowupMessage: async (result, _context) => {
      const content =
        result.content && typeof result.content === "object"
          ? (result.content as {
              deletedCount?: number;
              restorableCount?: number;
              results?: Array<{ status?: string }>;
            })
          : null;
      if (!content) return null;

      const deleted = content.deletedCount || 0;
      const rows = Array.isArray(content.results) ? content.results : [];
      let notFound = 0;
      let notAnnotation = 0;
      let errored = 0;
      for (const r of rows) {
        if (r.status === "not_found") notFound++;
        else if (r.status === "not_annotation") notAnnotation++;
        else if (r.status === "error") errored++;
      }
      const skipped = notFound + notAnnotation + errored;
      if (!deleted && !skipped) return null;

      const parts: string[] = [
        `Deleted ${deleted} annotation${deleted === 1 ? "" : "s"} from the paper's PDF.`,
      ];
      if (content.restorableCount) {
        parts.push(
          content.restorableCount === deleted
            ? "Use undo to restore them."
            : `Use undo to restore ${content.restorableCount} of them.`,
        );
      }
      const issues: string[] = [];
      if (notFound) issues.push(`${notFound} not found`);
      if (notAnnotation) issues.push(`${notAnnotation} not an annotation`);
      if (errored) issues.push(`${errored} failed`);
      if (issues.length) parts.push(`Skipped ${skipped} (${issues.join(", ")}).`);

      return { role: "assistant" as const, content: parts.join(" ") };
    },
  };
}
