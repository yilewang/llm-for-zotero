import { isGlobalPortalItem } from "../../../modules/contextPanel/portalScope";
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  ok,
  validateObject,
  type NoteSaveTarget,
} from "../shared";

type SaveAnswerToNoteInput = {
  content: string;
  modelName?: string;
  target?: NoteSaveTarget;
  /** Optional Zotero item ID to save the note to instead of the active item */
  targetItemId?: number;
};

export function createSaveAnswerToNoteTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SaveAnswerToNoteInput, unknown> {
  return {
    spec: {
      name: "save_answer_to_note",
      description:
        "Save a piece of assistant-authored content into a Zotero note for the active paper after user confirmation.",
      inputSchema: {
        type: "object",
        required: ["content"],
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          modelName: { type: "string" },
          target: {
            type: "string",
            enum: ["item", "standalone"],
          },
          targetItemId: {
            type: "number",
            description:
              "Optional Zotero item ID to attach the note to instead of the currently active item",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Save to Note",
      summaries: {
        onCall: "Preparing a note draft",
        onPending: "Waiting for your approval before saving the note",
        onApproved: "Approval received - saving the note",
        onDenied: "Note save cancelled",
        onSuccess: ({ content }) => {
          const status =
            content && typeof content === "object"
              ? (content as { status?: unknown }).status
              : undefined;
          if (status === "appended") {
            return "Saved the note to the current item";
          }
          if (status === "standalone_created") {
            return "Saved the note as a standalone note";
          }
          return "Saved the note";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      if (typeof args.content !== "string" || !args.content.trim()) {
        return fail("content is required");
      }
      return ok({
        content: args.content.trim(),
        modelName:
          typeof args.modelName === "string" && args.modelName.trim()
            ? args.modelName.trim()
            : undefined,
        target:
          args.target === "standalone" || args.target === "item"
            ? (args.target as NoteSaveTarget)
            : undefined,
        targetItemId: normalizePositiveInt(args.targetItemId),
      });
    },
    createPendingAction: (input, context) => {
      const isPaperChat = Boolean(
        context.item && !isGlobalPortalItem(context.item),
      );
      const saveTargets = isPaperChat
        ? [
            { id: "item", label: "Save as item note" },
            { id: "standalone", label: "Save as standalone note" },
          ]
        : [{ id: "standalone", label: "Save as standalone note" }];
      return {
        toolName: "save_answer_to_note",
        title: "Review note content",
        confirmLabel: "Save note",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "textarea",
            id: "content",
            label: "Note content",
            value: input.content,
          },
          ...(saveTargets.length > 1
            ? [
                {
                  type: "select" as const,
                  id: "target",
                  label: "Save target",
                  value:
                    input.target || (isPaperChat ? "item" : "standalone"),
                  options: saveTargets,
                },
              ]
            : []),
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      const content =
        typeof resolutionData.content === "string" &&
        resolutionData.content.trim()
          ? resolutionData.content.trim()
          : input.content;
      const target =
        resolutionData.target === "standalone" ||
        resolutionData.target === "item"
          ? (resolutionData.target as NoteSaveTarget)
          : input.target;
      if (!content) {
        return fail("content is required");
      }
      return ok({
        ...input,
        content,
        target,
      });
    },
    execute: async (input, context) => {
      const item =
        (input.targetItemId
          ? zoteroGateway.getItem(input.targetItemId)
          : null) ||
        zoteroGateway.getItem(context.request.activeItemId) ||
        context.item;
      const result = await zoteroGateway.saveAnswerToNote({
        item,
        libraryID: context.request.libraryID,
        content: input.content,
        modelName: input.modelName || context.modelName,
        target: input.target,
      });
      return {
        status: result,
      };
    },
  };
}
