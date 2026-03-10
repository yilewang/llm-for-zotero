import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";

type DetectDuplicatesInput = {
  libraryID?: number;
  limit?: number;
};

export function createDetectDuplicatesTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<DetectDuplicatesInput, unknown> {
  return {
    spec: {
      name: "detect_duplicates",
      description:
        "Scan the Zotero library for duplicate papers — items with the same DOI or identical normalised title. Returns groups of duplicates so the user can decide which to keep or merge.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          libraryID: { type: "number" },
          limit: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Detect Duplicates",
      summaries: {
        onCall: "Scanning the library for duplicate papers",
        onSuccess: ({ content }) => {
          const total =
            content && typeof content === "object"
              ? Number(
                  (content as { totalGroups?: unknown }).totalGroups || 0,
                )
              : 0;
          return total > 0
            ? `Found ${total} group${total === 1 ? "" : "s"} of potential duplicates`
            : "No duplicates found";
        },
        onEmpty: "No duplicate papers found in the library",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      return ok<DetectDuplicatesInput>({
        libraryID: normalizePositiveInt(args.libraryID),
        limit: normalizePositiveInt(args.limit),
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
      return zoteroGateway.detectDuplicatesInLibrary({
        libraryID,
        limit: input.limit,
      });
    },
  };
}
