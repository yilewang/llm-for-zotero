/**
 * The attachment delegate of library_update (kind:'attachment'): delete,
 * rename, or re-link a Zotero attachment; attach a file or a web page to an
 * item; or run Zotero's Find Available PDF for it. Not registered on its own;
 * its guidance lives on library_update.
 */
import type {
  AgentToolInputValidation,
  AgentWriteToolDefinition,
} from "../../types";
import { describeLibraryMutationInput } from "../../contracts/actionContract";
import {
  LibraryMutationService,
  type AttachFileOperation,
  type AttachUrlOperation,
  type DeleteAttachmentOperation,
  type FindPdfOperation,
  type RenameAttachmentOperation,
  type RelinkAttachmentOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

type AttachmentUpdateInput = {
  operation:
    | DeleteAttachmentOperation
    | RenameAttachmentOperation
    | RelinkAttachmentOperation
    | AttachFileOperation
    | AttachUrlOperation
    | FindPdfOperation;
};

const ATTACH_ACTIONS = ["attach_file", "attach_url", "find_pdf"];

/** What an attach, or a search, writes under: the item and its title. */
function parentTitle(zoteroGateway: ZoteroGateway, itemId: number): string {
  const item = zoteroGateway.getItem(itemId);
  return String(item?.getField?.("title") || "") || `Item ${itemId}`;
}

/** The review card for an attach or a find. Each names what it fetches. */
function attachCard(
  operation: AttachFileOperation | AttachUrlOperation | FindPdfOperation,
  zoteroGateway: ZoteroGateway,
) {
  const itemId =
    operation.type === "find_pdf" ? operation.itemId : operation.parentItemId;
  const item = {
    type: "text" as const,
    id: "item",
    label: "Item",
    value: parentTitle(zoteroGateway, itemId),
  };
  if (operation.type === "attach_file")
    return {
      toolName: "attachment_update",
      title: operation.link ? "Link a file" : "Attach a file",
      description: operation.link
        ? "Link this file to the item where it is. This can be undone."
        : "Copy this file into Zotero under the item. This can be undone.",
      confirmLabel: "Attach",
      cancelLabel: "Cancel",
      fields: [
        item,
        {
          type: "text" as const,
          id: "file",
          label: "File",
          value: operation.filePath,
        },
      ],
    };
  if (operation.type === "attach_url")
    return {
      toolName: "attachment_update",
      title: "Save a web page",
      description:
        "Zotero downloads this page and saves a snapshot of it and a link to it under the item. This can be undone.",
      confirmLabel: "Save",
      cancelLabel: "Cancel",
      fields: [
        item,
        {
          type: "text" as const,
          id: "url",
          label: "Web page",
          value: operation.url,
        },
      ],
    };
  return {
    toolName: "attachment_update",
    title: "Find available PDF",
    description:
      "Zotero looks online for a PDF of this item by its DOI and URL and in open-access sources, and attaches the first one it finds. This can be undone.",
    confirmLabel: "Find PDF",
    cancelLabel: "Cancel",
    fields: [item],
  };
}

export function createAttachmentUpdateTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<AttachmentUpdateInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    describeAction: describeLibraryMutationInput,
    effectOperations: [
      "delete_attachment",
      "rename_attachment",
      "relink_attachment",
      "attach_file",
      "attach_url",
      "find_pdf",
    ],
    spec: {
      name: "attachment_update",
      description:
        "Delete, rename, or re-link Zotero attachments; attach a file or a web page to an item, or find its PDF.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: [
              "delete",
              "rename",
              "relink",
              "attach_file",
              "attach_url",
              "find_pdf",
            ],
            description:
              "'delete' moves the attachment to trash, 'rename' renames the file on disk, 'relink' points the attachment at a different file. 'attach_file' attaches a local file to itemId, 'attach_url' saves a web page to it as a link and a snapshot, 'find_pdf' runs Zotero's Find Available PDF for it.",
          },
          attachmentId: {
            type: "number",
            description: "The Zotero item ID of the attachment.",
          },
          itemId: {
            type: "number",
            description:
              "For 'attach_file', 'attach_url' and 'find_pdf': the regular item.",
          },
          filePath: {
            type: "string",
            description: "For 'attach_file': the file's absolute path.",
          },
          link: {
            type: "boolean",
            description:
              "For 'attach_file': link to the file where it is instead of copying it into Zotero.",
          },
          url: {
            type: "string",
            description: "For 'attach_url': the http or https address.",
          },
          newName: {
            type: "string",
            description: "For action 'rename': the new filename.",
          },
          newPath: {
            type: "string",
            description:
              "For action 'relink': the new absolute path of the file this attachment should point at.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Update Attachments",
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const action = String(a.action || "manage");
          if (action === "attach_url") return "Preparing to save a web page";
          if (action === "find_pdf") return "Preparing to find a PDF";
          if (action === "attach_file") return "Preparing to attach a file";
          return `Preparing to ${action} attachment`;
        },
        onPending: "Waiting for confirmation on attachment change",
        onApproved: "Applying attachment change",
        onDenied: "Attachment change cancelled",
        onSuccess: ({ effect }) =>
          effect === "none" ? "No attachment changed" : "Attachment updated",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with action and attachmentId");
      }
      const action = args.action;
      if (ATTACH_ACTIONS.includes(String(action))) return validateAttach(args);
      const attachmentId = normalizePositiveInt(args.attachmentId);
      if (!attachmentId) {
        return fail("attachmentId is required");
      }

      if (action === "delete") {
        const operation: DeleteAttachmentOperation = {
          type: "delete_attachment",
          attachmentId,
        };
        return ok<AttachmentUpdateInput>({ operation });
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
        return ok<AttachmentUpdateInput>({ operation });
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
        return ok<AttachmentUpdateInput>({ operation });
      }

      return fail(
        "action must be one of: 'delete', 'rename', 'relink', 'attach_file', 'attach_url', 'find_pdf'",
      );
    },

    createPendingAction(input) {
      const { operation } = input;
      if (
        operation.type === "attach_file" ||
        operation.type === "attach_url" ||
        operation.type === "find_pdf"
      )
        return attachCard(operation, zoteroGateway);
      const info = zoteroGateway.getAttachmentInfo({
        attachmentId: operation.attachmentId,
      });
      const title = info?.title || `Attachment ${operation.attachmentId}`;

      if (operation.type === "delete_attachment") {
        return {
          toolName: "attachment_update",
          title: "Delete attachment",
          description: `Move "${title}" to the Zotero trash. This can be undone.`,
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "text" as const,
              id: "info",
              label: "Attachment",
              value: title,
            },
          ],
        };
      }

      if (operation.type === "rename_attachment") {
        return {
          toolName: "attachment_update",
          title: "Rename attachment",
          description: `Rename "${title}" to "${operation.newName}".`,
          confirmLabel: "Rename",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "text" as const,
              id: "from",
              label: "Current name",
              value: title,
            },
            {
              type: "text" as const,
              id: "to",
              label: "New name",
              value: operation.newName,
            },
          ],
        };
      }

      // relink_attachment
      return {
        toolName: "attachment_update",
        title: "Re-link attachment",
        description: `Update the file path for "${title}".`,
        confirmLabel: "Re-link",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "attachment",
            label: "Attachment",
            value: title,
          },
          {
            type: "text" as const,
            id: "path",
            label: "New path",
            value: (operation as RelinkAttachmentOperation).newPath,
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      // The "New name" and "New path" fields render as real <input> elements
      // the user can type into — there is no read-only text field in this
      // renderer. Discarding the edit meant correcting a wrong filename or a
      // wrong path did nothing, and for re-link, correcting the path is the
      // entire point of the operation.
      const data =
        resolutionData && typeof resolutionData === "object"
          ? (resolutionData as Record<string, unknown>)
          : undefined;
      if (!data) return ok(input);

      if (input.operation.type === "rename_attachment") {
        const edited = typeof data.to === "string" ? data.to.trim() : "";
        if (!edited) {
          return fail(
            "The new attachment name was left empty. Enter a filename or cancel.",
          );
        }
        return ok({
          ...input,
          operation: { ...input.operation, newName: edited },
        });
      }

      if (input.operation.type === "attach_file" && "file" in data) {
        const edited = typeof data.file === "string" ? data.file.trim() : "";
        if (!edited)
          return fail("The file path was left empty. Enter a path or cancel.");
        return ok({
          ...input,
          operation: { ...input.operation, filePath: edited },
        });
      }

      if (input.operation.type === "attach_url" && "url" in data) {
        const edited = typeof data.url === "string" ? data.url.trim() : "";
        if (!/^https?:\/\/\S+$/i.test(edited))
          return fail(
            "The web address must be an http or https address. Enter one or cancel.",
          );
        return ok({
          ...input,
          operation: { ...input.operation, url: edited },
        });
      }

      if (input.operation.type === "relink_attachment") {
        const edited = typeof data.path === "string" ? data.path.trim() : "";
        if (!edited) {
          return fail(
            "The new file path was left empty. Enter a path or cancel.",
          );
        }
        return ok({
          ...input,
          operation: { ...input.operation, newPath: edited },
        });
      }

      return ok(input);
    },

    planInvocation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "attachment_update",
      );
    },
  };
}

/** attach_file, attach_url and find_pdf name the regular item, not an attachment. */
function validateAttach(
  args: Record<string, unknown>,
): AgentToolInputValidation<AttachmentUpdateInput> {
  const itemId = normalizePositiveInt(args.itemId);
  if (!itemId)
    return fail(
      `itemId is required for action '${String(args.action)}': the regular item to attach to.`,
    );
  if (args.action === "find_pdf") {
    const operation: FindPdfOperation = { type: "find_pdf", itemId };
    return ok<AttachmentUpdateInput>({ operation });
  }
  if (args.action === "attach_file") {
    const filePath =
      typeof args.filePath === "string" ? args.filePath.trim() : "";
    if (!filePath)
      return fail("filePath is required for action 'attach_file'.");
    const operation: AttachFileOperation = {
      type: "attach_file",
      parentItemId: itemId,
      filePath,
      link: args.link === true,
    };
    return ok<AttachmentUpdateInput>({ operation });
  }
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url))
    return fail(
      "url is required for action 'attach_url' and must be an http or https address.",
    );
  const operation: AttachUrlOperation = {
    type: "attach_url",
    parentItemId: itemId,
    url,
  };
  return ok<AttachmentUpdateInput>({ operation });
}
