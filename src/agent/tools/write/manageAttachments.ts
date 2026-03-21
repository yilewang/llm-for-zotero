/**
 * Tool for managing Zotero attachments — delete, rename, or re-link.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type DeleteAttachmentOperation,
  type RenameAttachmentOperation,
  type RelinkAttachmentOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type ManageAttachmentsInput = {
  operation: DeleteAttachmentOperation | RenameAttachmentOperation | RelinkAttachmentOperation;
};

export function createManageAttachmentsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ManageAttachmentsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "manage_attachments",
      description:
        "Manage Zotero attachments: delete, rename, or re-link broken file paths.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "attachmentId"],
        properties: {
          action: {
            type: "string",
            enum: ["delete", "rename", "relink"],
            description:
              "'delete' moves the attachment to trash, 'rename' changes the filename, 'relink' updates a linked-file path.",
          },
          attachmentId: {
            type: "number",
            description: "The Zotero item ID of the attachment.",
          },
          newName: {
            type: "string",
            description: "For action 'rename': the new filename.",
          },
          newPath: {
            type: "string",
            description:
              "For action 'relink': the new absolute file path for a linked-file attachment.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        /\b(attachment|rename.*file|relink|broken.*link|missing.*file|delete.*attachment|remove.*attachment)\b/i.test(
          request.userText || "",
        ),
      instruction:
        "Use manage_attachments to delete, rename, or re-link attachments. " +
        "To find attachments, use read_library with sections:['attachments'] first. " +
        "Re-linking only works for linked-file attachments (not imported copies).",
    },

    presentation: {
      label: "Manage Attachments",
      summaries: {
        onCall: ({ args }) => {
          const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
          const action = String(a.action || "manage");
          return `Preparing to ${action} attachment`;
        },
        onPending: "Waiting for confirmation on attachment change",
        onApproved: "Applying attachment change",
        onDenied: "Attachment change cancelled",
        onSuccess: "Attachment updated",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with action and attachmentId");
      }
      const action = args.action;
      const attachmentId = normalizePositiveInt(args.attachmentId);
      if (!attachmentId) {
        return fail("attachmentId is required");
      }

      if (action === "delete") {
        const operation: DeleteAttachmentOperation = {
          type: "delete_attachment",
          attachmentId,
        };
        return ok<ManageAttachmentsInput>({ operation });
      }

      if (action === "rename") {
        if (typeof args.newName !== "string" || !args.newName.trim()) {
          return fail("newName is required for action 'rename'");
        }
        const operation: RenameAttachmentOperation = {
          type: "rename_attachment",
          attachmentId,
          newName: args.newName.trim(),
        };
        return ok<ManageAttachmentsInput>({ operation });
      }

      if (action === "relink") {
        if (typeof args.newPath !== "string" || !args.newPath.trim()) {
          return fail("newPath is required for action 'relink'");
        }
        const operation: RelinkAttachmentOperation = {
          type: "relink_attachment",
          attachmentId,
          newPath: args.newPath.trim(),
        };
        return ok<ManageAttachmentsInput>({ operation });
      }

      return fail("action must be one of: 'delete', 'rename', 'relink'");
    },

    createPendingAction(input) {
      const { operation } = input;
      const info = zoteroGateway.getAttachmentInfo({ attachmentId: operation.attachmentId });
      const title = info?.title || `Attachment ${operation.attachmentId}`;

      if (operation.type === "delete_attachment") {
        return {
          toolName: "manage_attachments",
          title: "Delete attachment",
          description: `Move "${title}" to the Zotero trash. This can be undone.`,
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          fields: [
            { type: "text" as const, id: "info", label: "Attachment", value: title },
          ],
        };
      }

      if (operation.type === "rename_attachment") {
        return {
          toolName: "manage_attachments",
          title: "Rename attachment",
          description: `Rename "${title}" to "${operation.newName}".`,
          confirmLabel: "Rename",
          cancelLabel: "Cancel",
          fields: [
            { type: "text" as const, id: "from", label: "Current name", value: title },
            { type: "text" as const, id: "to", label: "New name", value: operation.newName },
          ],
        };
      }

      // relink_attachment
      return {
        toolName: "manage_attachments",
        title: "Re-link attachment",
        description: `Update the file path for "${title}".`,
        confirmLabel: "Re-link",
        cancelLabel: "Cancel",
        fields: [
          { type: "text" as const, id: "attachment", label: "Attachment", value: title },
          { type: "text" as const, id: "path", label: "New path", value: (operation as RelinkAttachmentOperation).newPath },
        ],
      };
    },

    applyConfirmation(input, _resolutionData) {
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "manage_attachments",
      );
    },
  };
}
