/**
 * Tool for updating existing PDF annotations — modify comment, colour, and/or text.
 * Supports batch updates with undo.
 */
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { resolveAnnotationColor } from "../../services/zoteroGateway";
import type { AgentToolDefinition } from "../../types";
import type { PaperContextRef } from "../../../shared/types";
import { pushUndoEntry, createUndoRedoPair } from "../../store/undoStore";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  PAPER_CONTEXT_REF_SCHEMA,
} from "../shared";
import {
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";

// ── Types ────────────────────────────────────────────────────────────────────

type AnnotationUpdateOperation = {
  /** ID of the annotation to update (from annotation_find or library_read output). */
  annotationId: number;
  /** New comment text. Set to "" to clear. Omit to leave unchanged. */
  comment?: string;
  /** New colour — accepts name ("yellow") or hex ("#ffd400"). Omit to leave unchanged. */
  color?: string;
  /** New annotation text. Omit to leave unchanged. */
  text?: string;
};

type AnnotationUpdateInput = {
  /** The paper whose annotations are being updated (for attribution and undo context). */
  paperContext: PaperContextRef;
  /** One or more update operations. Max 50 per call. */
  operations: AnnotationUpdateOperation[];
};

type AnnotationUpdateResultEntry = {
  annotationId: number;
  updated: boolean;
  previous?: {
    comment?: string;
    color?: string;
    text?: string;
  };
};

type AnnotationUpdateResult = {
  results: AnnotationUpdateResultEntry[];
  updatedCount: number;
  paperContext: PaperContextRef;
};

const MAX_OPERATIONS = 50;

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function summarizeOperation(op: AnnotationUpdateOperation): string {
  const parts: string[] = [];
  if (op.comment !== undefined) {
    parts.push(op.comment ? `comment: "${op.comment.slice(0, 40)}"` : "clear comment");
  }
  if (op.color !== undefined) {
    parts.push(`colour: ${op.color}`);
  }
  if (op.text !== undefined) {
    parts.push(`text: "${op.text.slice(0, 40)}"`);
  }
  return parts.length
    ? `${op.annotationId}: ${parts.join(", ")}`
    : `${op.annotationId}: (no changes)`;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export function createAnnotationUpdateTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<AnnotationUpdateInput, AnnotationUpdateResult> {
  return {
    spec: {
      name: "annotation_update",
      description:
        "Modify existing PDF annotations: change their comment, colour, or text. " +
        "Use annotation_find first to locate annotation IDs, then pass them here. " +
        "Batch up to 50 updates per call. Supports undo via undo_last_action.",
      inputSchema: {
        type: "object",
        required: ["paperContext", "operations"],
        additionalProperties: false,
        properties: {
          paperContext: {
            ...PAPER_CONTEXT_REF_SCHEMA,
            description:
              "Paper context reference for the paper whose annotations are being updated.",
          },
          operations: {
            type: "array",
            description:
              "One or more update operations. Each specifies an annotationId and the fields to change.",
            items: {
              type: "object",
              required: ["annotationId"],
              additionalProperties: false,
              properties: {
                annotationId: {
                  type: "number",
                  description: "ID of the annotation to update.",
                },
                comment: {
                  type: "string",
                  description:
                    "New comment text. Set to '' (empty string) to clear the comment. Omit to leave unchanged.",
                },
                color: {
                  type: "string",
                  description:
                    "New colour — accepts name (e.g. 'yellow') or hex (e.g. '#ffd400'). Omit to leave unchanged.",
                },
                text: {
                  type: "string",
                  description:
                    "New annotation text. Omit to leave unchanged.",
                },
              },
            },
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: () => true,
      instruction:
        "Use annotation_update to modify existing annotations' comments, colours, or text. " +
        "WORKFLOW: first call annotation_find to locate the annotations you want to change; " +
        "it returns each annotation's annotationId plus the itemId and contextItemId you need " +
        "to build paperContext. Then pass that paperContext and the annotationIds to " +
        "annotation_update with the desired changes. " +
        "To change an annotation type (e.g. highlight → note), delete and recreate instead. " +
        "Set comment to '' to clear a comment. Omit fields to leave them unchanged.",
    },

    presentation: {
      label: "Update Annotations",
      summaries: {
        onCall: "Preparing to update annotations",
        onPending: "Review annotation changes",
        onApproved: "Updating annotations",
        onDenied: "Annotation update cancelled",
        onSuccess: ({ content }) => {
          if (!content || typeof content !== "object") return "Annotations updated";
          const result = content as AnnotationUpdateResult;
          return result.updatedCount > 0
            ? `Updated ${result.updatedCount} annotation${result.updatedCount === 1 ? "" : "s"}`
            : "No changes were needed";
        },
      },
    },

    // ── Validation ───────────────────────────────────────────────────────

    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with paperContext and operations.",
        );
      }

      // Validate paperContext
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

      // Validate operations
      if (!Array.isArray(args.operations) || !args.operations.length) {
        return fail("operations must be a non-empty array of update operations");
      }
      if (args.operations.length > MAX_OPERATIONS) {
        return fail(
          `Too many operations (${args.operations.length}). Maximum is ${MAX_OPERATIONS}.`,
        );
      }

      const operations: AnnotationUpdateOperation[] = [];
      for (let i = 0; i < args.operations.length; i++) {
        const raw = args.operations[i];
        if (!validateObject<Record<string, unknown>>(raw)) {
          return fail(`operations[${i}] must be an object`);
        }
        const annotationId = normalizePositiveInt(raw.annotationId);
        if (!annotationId) {
          return fail(`operations[${i}].annotationId is required (number)`);
        }

        const op: AnnotationUpdateOperation = { annotationId };

        if (raw.comment !== undefined) {
          if (typeof raw.comment !== "string") {
            return fail(`operations[${i}].comment must be a string`);
          }
          op.comment = raw.comment;
        }

        if (raw.color !== undefined) {
          if (typeof raw.color !== "string" || !raw.color.trim()) {
            return fail(
              `operations[${i}].color must be a non-empty string (colour name or hex)`,
            );
          }
          op.color = resolveAnnotationColor(raw.color.trim());
        }

        if (raw.text !== undefined) {
          if (typeof raw.text !== "string") {
            return fail(`operations[${i}].text must be a string`);
          }
          op.text = raw.text;
        }

        // Ensure at least one field to update
        if (op.comment === undefined && op.color === undefined && op.text === undefined) {
          return fail(
            `operations[${i}]: at least one of comment, color, or text must be provided`,
          );
        }

        operations.push(op);
      }

      return ok<AnnotationUpdateInput>({ paperContext, operations });
    },

    // ── Confirmation card ────────────────────────────────────────────────

    createPendingAction: (input, context) => {
      void context;
      const paperContext = input.paperContext;

      const summaryLines = input.operations.map((op) => summarizeOperation(op));

      // Count changes by type
      let commentChanges = 0;
      let colorChanges = 0;
      let textChanges = 0;
      for (const op of input.operations) {
        if (op.comment !== undefined) commentChanges++;
        if (op.color !== undefined) colorChanges++;
        if (op.text !== undefined) textChanges++;
      }
      const changeParts: string[] = [];
      if (commentChanges) changeParts.push(`${commentChanges} comment${commentChanges > 1 ? "s" : ""}`);
      if (colorChanges) changeParts.push(`${colorChanges} colour${colorChanges > 1 ? "s" : ""}`);
      if (textChanges) changeParts.push(`${textChanges} text`);
      const changeSummary = changeParts.join(", ");

      return {
        toolName: "annotation_update",
        mode: "review" as const,
        title: "Update Annotations",
        description: `Paper: ${formatPaperSourceLabel(paperContext)} · ${input.operations.length} annotation${input.operations.length === 1 ? "" : "s"} · ${changeSummary}`,
        confirmLabel: "Update Annotations",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "textarea" as const,
            id: "updateSummary",
            label: "Changes",
            value: summaryLines.join("\n"),
          },
        ],
      };
    },

    applyConfirmation: (input, _resolutionData) => {
      return ok(input);
    },

    // ── Execution ───────────────────────────────────────────────────────

    execute: async (input, context) => {
      const Zotero = (globalThis as any).Zotero;
      if (!Zotero?.Items) {
        throw new Error("Zotero API not available");
      }

      const results: AnnotationUpdateResultEntry[] = [];
      let updatedCount = 0;

      // Collect previous states for undo
      const previousStates: Array<{
        annotationId: number;
        comment?: string;
        color?: string;
        text?: string;
      }> = [];

      for (const op of input.operations) {
        const updateResult = await zoteroGateway.updateAnnotation({
          annotationId: op.annotationId,
          comment: op.comment,
          color: op.color,
          text: op.text,
        });

        if (updateResult.updated && updateResult.previous) {
          previousStates.push({
            annotationId: op.annotationId,
            ...updateResult.previous,
          });
        }

        results.push({
          annotationId: updateResult.annotationId,
          updated: updateResult.updated,
          previous: updateResult.previous,
        });

        if (updateResult.updated) updatedCount++;
      }

      // Undo support: restore previous values
      if (previousStates.length > 0) {
        const { revert, restore } = createUndoRedoPair({
          undo: async () => {
            for (const prev of previousStates) {
              await zoteroGateway.updateAnnotation({
                annotationId: prev.annotationId,
                comment: prev.comment,
                color: prev.color,
                text: prev.text,
              });
            }
          },
          redo: async () => {
            for (const op of input.operations) {
              await zoteroGateway.updateAnnotation({
                annotationId: op.annotationId,
                comment: op.comment,
                color: op.color,
                text: op.text,
              });
            }
          },
        });

        pushUndoEntry(context.request.conversationKey, {
          id: `undo-annotation_update-${Date.now()}`,
          toolName: "annotation_update",
          description:
            `Revert ${previousStates.length} annotation update${previousStates.length === 1 ? "" : "s"}`,
          revert,
          restore,
        });
      }

      return {
        kind: "result" as const,
        content: {
          results,
          updatedCount,
          paperContext: input.paperContext,
        },
      };
    },

    buildFollowupMessage: async (result, _context) => {
      const content =
        result.content && typeof result.content === "object"
          ? (result.content as AnnotationUpdateResult)
          : null;
      if (!content) return null;

      if (content.updatedCount === 0) {
        return { role: "assistant" as const, content: "No annotations were modified (values unchanged)." };
      }

      const lines: string[] = [];
      for (const r of content.results) {
        if (!r.updated) continue;
        const changes: string[] = [];
        if (r.previous?.comment !== undefined) {
          changes.push(
            r.previous.comment
              ? `comment from "${r.previous.comment.slice(0, 60)}"`
              : "comment (was empty)",
          );
        }
        if (r.previous?.color !== undefined) {
          changes.push(`colour from ${r.previous.color}`);
        }
        if (r.previous?.text !== undefined) {
          changes.push(
            r.previous.text
              ? `text from "${r.previous.text.slice(0, 60)}"`
              : "text (was empty)",
          );
        }
        lines.push(`  • annotation ${r.annotationId}: updated ${changes.join(", ")}`);
      }
      if (lines.length === 0) return null;

      return {
        role: "assistant" as const,
        content:
          `Updated ${content.updatedCount} annotation${content.updatedCount === 1 ? "" : "s"} on ${formatPaperSourceLabel(content.paperContext)}:\n` +
          lines.join("\n"),
      };
    },
  };
}
