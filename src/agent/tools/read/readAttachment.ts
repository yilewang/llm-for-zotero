import type { AgentToolDefinition } from "../../types";
import type { PdfPageService } from "../../services/pdfPageService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { AttachmentReadService } from "../../services/attachmentReadService";
import {
  fail,
  findAttachment,
  normalizePositiveInt,
  ok,
  validateObject,
} from "../shared";
import { normalizeTarget, firstNonImageAttachment } from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";

type ReadAttachmentInput = {
  target?: PdfTarget;
  maxChars?: number;
  attachFile?: boolean;
};

export function createReadAttachmentTool(
  zoteroGateway: ZoteroGateway,
  pdfPageService: PdfPageService,
): AgentToolDefinition<ReadAttachmentInput, unknown> {
  const attachmentReadService = new AttachmentReadService(zoteroGateway);

  return {
    spec: {
      name: "read_attachment",
      description:
        "Read the content of any Zotero attachment (HTML snapshots, text files, " +
        "images) by contextItemId. Set attachFile to send the whole file to the " +
        "model for direct reading.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: {
            type: "object",
            description: "Target attachment.",
            properties: {
              contextItemId: {
                type: "number",
                description: "Zotero attachment item ID",
              },
              itemId: {
                type: "number",
                description: "Zotero parent item ID",
              },
              attachmentId: {
                type: "string",
                description: "Uploaded attachment ID",
              },
              name: {
                type: "string",
                description: "Uploaded attachment name",
              },
            },
            additionalProperties: false,
          },
          maxChars: {
            type: "number",
            description: "Text truncation limit. Omit to read full content.",
          },
          attachFile: {
            type: "boolean",
            description:
              "If true, prepare the whole file as a model-readable artifact " +
              "instead of reading content inline.",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Read Attachment",
      summaries: {
        onCall: ({ args }) => {
          const a = args as Record<string, unknown> | null;
          return a?.attachFile
            ? "Preparing file for model"
            : "Reading attachment content";
        },
        onPending: "Waiting for your approval before sending document content",
        onApproved: "Approval received - sending document content",
        onDenied: "Attachment reading cancelled",
        onSuccess: ({ content }) => {
          const c = content as Record<string, unknown> | null;
          if (c?.result) return "Prepared the file for direct reading";
          return "Read attachment content";
        },
      },
    },
    shouldRequireConfirmation: async (input) => {
      // Only require confirmation for attachFile mode (sending whole file)
      return Boolean(input.attachFile);
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const input: ReadAttachmentInput = {
        target: normalizeTarget(args.target),
        maxChars: normalizePositiveInt(args.maxChars),
        attachFile: args.attachFile === true,
      };
      if (!input.attachFile && !input.target?.contextItemId) {
        return fail(
          "read_attachment requires target.contextItemId — the Zotero attachment item ID to read",
        );
      }
      return ok(input);
    },
    createPendingAction: async (input, context) => {
      if (!input.attachFile) return null as never;

      const explicitTarget = input.target;
      const attachment =
        (explicitTarget?.attachmentId || explicitTarget?.name
          ? findAttachment(context.request.attachments, {
              attachmentId: explicitTarget.attachmentId,
              name: explicitTarget.name,
            })
          : null) || firstNonImageAttachment(context.request.attachments);
      const attachmentName =
        attachment?.name || explicitTarget?.name || "Attached file";
      const mimeType = attachment?.mimeType || "application/pdf";
      return {
        toolName: "read_attachment",
        title: attachmentName,
        description:
          'Review the file details below. Click "Send to model" to let the model inspect this attachment.',
        confirmLabel: "Send to model",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "review_table",
            id: "fileReview",
            rows: [
              {
                key: "file",
                label: "File",
                before: attachment?.category || "attachment",
                after: attachmentName,
              },
              {
                key: "mimeType",
                label: "Type",
                before: attachment?.category || "attachment",
                after: mimeType,
              },
            ],
          },
        ],
      };
    },
    execute: async (input, context) => {
      if (input.attachFile) {
        // Attach file mode — prepare file for model
        const explicitTarget = input.target;
        const uploadedAttachment =
          (explicitTarget?.attachmentId || explicitTarget?.name
            ? findAttachment(context.request.attachments, {
                attachmentId: explicitTarget.attachmentId,
                name: explicitTarget.name,
              })
            : null) || firstNonImageAttachment(context.request.attachments);

        if (uploadedAttachment && uploadedAttachment.category !== "image") {
          if (uploadedAttachment.category === "pdf") {
            const prepared = await pdfPageService.preparePdfFileForModel({
              request: context.request,
              attachmentId: uploadedAttachment.id,
              name: uploadedAttachment.name,
            });
            return {
              content: {
                result: {
                  attachmentId: uploadedAttachment.id,
                  name: uploadedAttachment.name,
                  mimeType: uploadedAttachment.mimeType,
                },
              },
              artifacts: [prepared.artifact],
            };
          }
          return {
            results: [
              {
                id: uploadedAttachment.id,
                name: uploadedAttachment.name,
                mimeType: uploadedAttachment.mimeType,
                textContent: uploadedAttachment.textContent || "",
              },
            ],
          };
        }

        // Fall back to library PDF
        const prepared = await pdfPageService.preparePdfFileForModel({
          request: context.request,
          paperContext: explicitTarget?.paperContext,
          itemId: explicitTarget?.itemId,
          contextItemId: explicitTarget?.contextItemId,
          attachmentId: explicitTarget?.attachmentId,
          name: explicitTarget?.name,
        });
        return {
          content: {
            result: {
              title: prepared.target.title,
              mimeType: prepared.target.mimeType,
            },
          },
          artifacts: [prepared.artifact],
        };
      }

      // Read attachment content inline
      const contextItemId = input.target?.contextItemId;
      if (!contextItemId) {
        throw new Error(
          "read_attachment requires target.contextItemId — the Zotero attachment item ID to read",
        );
      }
      return attachmentReadService.readAttachmentContent({
        attachmentId: contextItemId,
        maxChars: input.maxChars,
      });
    },
  };
}
