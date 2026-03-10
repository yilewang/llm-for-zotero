import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";

type ReadPaperAnnotationsInput = {
  itemId?: number;
  maxAnnotations?: number;
};

export function createReadPaperAnnotationsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ReadPaperAnnotationsInput, unknown> {
  return {
    spec: {
      name: "read_paper_annotations",
      description:
        "Read the user's PDF highlights, underlines, and inline notes (annotations) from the Zotero PDF reader for a given paper. Useful for summarising what the user found important or for building on their prior reading notes.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: { type: "number" },
          maxAnnotations: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Read Annotations",
      summaries: {
        onCall: "Reading PDF annotations for the paper",
        onSuccess: "Loaded PDF annotations",
        onEmpty: "No annotations found for this paper",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      return ok<ReadPaperAnnotationsInput>({
        itemId: normalizePositiveInt(args.itemId),
        maxAnnotations: normalizePositiveInt(args.maxAnnotations),
      });
    },
    execute: async (input, context) => {
      const item = zoteroGateway.resolveMetadataItem({
        request: context.request,
        item: context.item,
        itemId: input.itemId,
      });
      const annotations = zoteroGateway.getPaperAnnotations({
        item,
        maxAnnotations: input.maxAnnotations,
      });
      if (!annotations.length) {
        return {
          annotations: [],
          message: "No PDF annotations found for this paper.",
        };
      }
      return { annotations, total: annotations.length };
    },
  };
}
