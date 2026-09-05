/**
 * Writes a note onto each of many items behind one confirmation.
 *
 * `note_write` takes a single `targetItemId` and every `mode:'create'` call
 * returns its own review card, so "write a summary note on each of my 50 most
 * recent papers" meant 50 tool calls and 50 human approvals. The round budget
 * was never the binding constraint — consent was.
 */
import type { AgentWriteToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type SaveNotesBatchOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  normalizeChecklistItemIdsFromResolution,
  planLibraryMutations,
} from "./mutateLibraryShared";

const NOTES_CHECKLIST_FIELD_ID = "writeNotesChecklist";

type WriteNotesBatchInput = { operation: SaveNotesBatchOperation };

export function createWriteNotesBatchTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<WriteNotesBatchInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "write_notes_batch",
      description:
        "Write a note onto each of many items in one approved operation. Use this instead of calling note_write once per paper — the user approves the whole set on a single card and can uncheck any of them.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["notes"],
        properties: {
          notes: {
            type: "array",
            description:
              "One entry per item. Write the actual note content for each — this tool does not generate it.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["targetItemId", "content"],
              properties: {
                targetItemId: {
                  type: "number",
                  description: "The item the note is attached to.",
                },
                content: {
                  type: "string",
                  description: "Note content, in Markdown.",
                },
                collections: {
                  type: "array",
                  items: { type: "number" },
                  description:
                    "Only for target:'standalone': collections to file the note into. A child note belongs to its parent and cannot be a collection member.",
                },
              },
            },
          },
          target: {
            type: "string",
            enum: ["item", "standalone"],
            default: "item",
            description:
              "'item' attaches each note to its target as a child note; 'standalone' creates free-standing notes.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Write Notes",
      summaries: {
        onCall: "Preparing notes",
        onPending: "Waiting for confirmation to write notes",
        onApproved: "Writing notes",
        onDenied: "Note writing cancelled",
        onSuccess: ({ content }) => {
          const outer =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const inner =
            outer.result && typeof outer.result === "object"
              ? (outer.result as Record<string, unknown>)
              : {};
          const innermost =
            inner.result && typeof inner.result === "object"
              ? (inner.result as Record<string, unknown>)
              : {};
          const created = Number(innermost.createdCount || 0);
          const failed = Number(innermost.failedCount || 0);
          if (!created) return "No notes written";
          return `Wrote ${created} note${created === 1 ? "" : "s"}${
            failed ? ` (${failed} failed)` : ""
          }`;
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with notes. Example: { notes: [{ targetItemId: 101, content: "## Summary\\n..." }] }',
        );
      }
      if (!Array.isArray(args.notes) || !args.notes.length) {
        return fail(
          "notes must be a non-empty array of { targetItemId, content }.",
        );
      }
      const notes: SaveNotesBatchOperation["notes"] = [];
      for (const raw of args.notes) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const targetItemId = normalizePositiveInt(raw.targetItemId);
        const content = typeof raw.content === "string" ? raw.content : "";
        if (!targetItemId || !content.trim()) continue;
        notes.push({
          targetItemId,
          content,
          collections: Array.isArray(raw.collections)
            ? (raw.collections
                .map((id) => normalizePositiveInt(id))
                .filter(Boolean) as number[])
            : undefined,
        });
      }
      if (!notes.length) {
        return fail(
          "Every note needs a targetItemId and non-empty content. Nothing valid was provided.",
        );
      }
      return ok({
        operation: {
          type: "save_notes_batch" as const,
          notes,
          target: args.target === "standalone" ? "standalone" : "item",
        },
      });
    },

    createPendingAction(input) {
      const notes = input.operation.notes;
      return {
        toolName: "write_notes_batch",
        title: `Write ${notes.length} note${notes.length === 1 ? "" : "s"}`,
        description: `Write a note onto ${notes.length} item${notes.length === 1 ? "" : "s"}. Uncheck any you do not want. This can be undone.`,
        confirmLabel: "Write notes",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: NOTES_CHECKLIST_FIELD_ID,
            label: "Notes to write",
            items: notes.map((note) => {
              const item = zoteroGateway.getItem(note.targetItemId);
              const title = item
                ? String(
                    item.getDisplayTitle?.() || `Item ${note.targetItemId}`,
                  )
                : `Item ${note.targetItemId}`;
              return {
                id: `${note.targetItemId}`,
                label: title,
                // A preview matters here: the user is approving fifty pieces
                // of generated text at once, and an unreviewable card is
                // consent in name only.
                description: previewOf(note.content),
                checked: true,
              };
            }),
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      const keep = normalizeChecklistItemIdsFromResolution(
        resolutionData,
        NOTES_CHECKLIST_FIELD_ID,
      );
      if (!keep) return ok(input);
      const kept = new Set(keep);
      const notes = input.operation.notes.filter((note) =>
        kept.has(note.targetItemId),
      );
      if (!notes.length) {
        return fail("Every note was unchecked, so there is nothing to write.");
      }
      return ok({ operation: { ...input.operation, notes } });
    },

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "write_notes_batch",
      );
    },
  };
}

function previewOf(content: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length > 160 ? `${flattened.slice(0, 160)}…` : flattened;
}
