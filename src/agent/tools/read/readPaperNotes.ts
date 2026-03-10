import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";

type ReadPaperNotesInput = {
  itemId?: number;
  maxNotes?: number;
};

export function createReadPaperNotesTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ReadPaperNotesInput, unknown> {
  return {
    spec: {
      name: "read_paper_notes",
      description:
        "Read existing Zotero notes attached to a paper. Returns the plain-text content of each note. Useful for building on prior research summaries or notes saved to the item.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: { type: "number" },
          maxNotes: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Read Paper Notes",
      summaries: {
        onCall: "Reading notes attached to the paper",
        onSuccess: "Loaded existing paper notes",
        onEmpty: "No notes found for this paper",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      return ok<ReadPaperNotesInput>({
        itemId: normalizePositiveInt(args.itemId),
        maxNotes: normalizePositiveInt(args.maxNotes),
      });
    },
    execute: async (input, context) => {
      const item = zoteroGateway.resolveMetadataItem({
        request: context.request,
        item: context.item,
        itemId: input.itemId,
      });
      const notes = zoteroGateway.getPaperNotes({
        item,
        maxNotes: input.maxNotes,
      });
      if (!notes.length) {
        return { notes: [], message: "No notes are attached to this paper." };
      }
      return { notes };
    },
  };
}
