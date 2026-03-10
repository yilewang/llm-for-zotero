import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";
import type { PaperContextRef } from "../../../modules/contextPanel/types";

type FindRelatedPapersInput = {
  itemId?: number;
  paperContext?: PaperContextRef;
  limit?: number;
  libraryID?: number;
};

export function createFindRelatedPapersInLibraryTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<FindRelatedPapersInput, unknown> {
  return {
    spec: {
      name: "find_related_papers_in_library",
      description:
        "Find papers in the Zotero library that are related to a given paper based on shared authors, title keywords, venue, and tags. Returns a ranked list of candidates with match reasons.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: { type: "number" },
          paperContext: {
            type: "object",
            required: ["itemId", "contextItemId"],
            additionalProperties: true,
            properties: {
              itemId: { type: "number" },
              contextItemId: { type: "number" },
              title: { type: "string" },
            },
          },
          limit: { type: "number" },
          libraryID: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Find Related Papers",
      summaries: {
        onCall: "Searching library for papers related to this one",
        onSuccess: "Found related papers in the library",
        onEmpty: "No related papers found in the library",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const paperContext = validateObject<Record<string, unknown>>(
        args.paperContext,
      )
        ? normalizeToolPaperContext(args.paperContext) || undefined
        : undefined;
      return ok<FindRelatedPapersInput>({
        itemId: normalizePositiveInt(args.itemId),
        paperContext,
        limit: normalizePositiveInt(args.limit),
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    execute: async (input, context) => {
      const libraryID = zoteroGateway.resolveLibraryID({
        request: context.request,
        item: context.item,
        libraryID: input.libraryID,
      });
      if (!libraryID) {
        throw new Error("No active library available");
      }
      const referenceItemId =
        input.itemId ||
        input.paperContext?.itemId ||
        context.request.activeItemId;
      if (!referenceItemId) {
        throw new Error("No reference paper specified");
      }
      return zoteroGateway.findRelatedPapersInLibrary({
        libraryID,
        referenceItemId,
        limit: input.limit,
      });
    },
  };
}
