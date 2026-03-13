import type { PaperContextRef } from "../../../shared/types";
import type { AgentToolDefinition } from "../../types";
import {
  LibraryReadService,
  type ReadLibrarySection,
} from "../../services/libraryReadService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";

type ReadLibraryInput = {
  itemIds?: number[];
  paperContexts?: PaperContextRef[];
  sections: ReadLibrarySection[];
  maxNotes?: number;
  maxAnnotations?: number;
};

const VALID_SECTIONS = new Set<ReadLibrarySection>([
  "metadata",
  "notes",
  "annotations",
  "attachments",
  "collections",
  "content",
]);

function normalizeSections(value: unknown): ReadLibrarySection[] | null {
  if (!Array.isArray(value)) return null;
  const sections = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is ReadLibrarySection =>
      VALID_SECTIONS.has(entry as ReadLibrarySection),
    );
  return sections.length ? Array.from(new Set(sections)) : null;
}

function normalizePaperContexts(
  value: unknown,
): PaperContextRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const contexts = value
    .map((entry) =>
      validateObject<Record<string, unknown>>(entry)
        ? normalizeToolPaperContext(entry)
        : null,
    )
    .filter((entry): entry is NonNullable<ReturnType<typeof normalizeToolPaperContext>> =>
      Boolean(entry),
    );
  return contexts.length ? contexts : undefined;
}

export function createReadLibraryTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ReadLibraryInput, unknown> {
  const readService = new LibraryReadService(zoteroGateway);
  return {
    spec: {
      name: "read_library",
      description:
        "Read structured Zotero item state for one or more items (papers, books, standalone notes, or any item type). Use sections to fetch metadata, notes (use 'content' or 'notes' for standalone notes), annotations, attachments (all types, not just PDFs), and collection membership keyed by item ID.",
      inputSchema: {
        type: "object",
        required: ["sections"],
        additionalProperties: false,
        properties: {
          itemIds: {
            type: "array",
            items: { type: "number" },
          },
          paperContexts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
            },
          },
          sections: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "metadata",
                "notes",
                "content",
                "annotations",
                "attachments",
                "collections",
              ],
            },
          },
          maxNotes: { type: "number" },
          maxAnnotations: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    presentation: {
      label: "Read Library",
      summaries: {
        onCall: "Reading structured Zotero item data",
        onSuccess: ({ content }) => {
          const results =
            content &&
            typeof content === "object" &&
            validateObject<Record<string, unknown>>(
              (content as { results?: unknown }).results,
            )
              ? (content as { results: Record<string, unknown> }).results
              : {};
          const count = Object.keys(results).length;
          return count > 0
            ? `Read ${count} item${count === 1 ? "" : "s"}`
            : "No matching items found";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const sections = normalizeSections(args.sections);
      if (!sections?.length) {
        return fail("sections must include at least one valid section");
      }
      return ok<ReadLibraryInput>({
        itemIds: normalizePositiveIntArray(args.itemIds) || undefined,
        paperContexts: normalizePaperContexts(args.paperContexts),
        sections,
        maxNotes: normalizePositiveInt(args.maxNotes),
        maxAnnotations: normalizePositiveInt(args.maxAnnotations),
      });
    },
    execute: async (input, context) => {
      return {
        sections: input.sections,
        results: readService.readItems({
          request: context.request,
          itemIds: input.itemIds,
          paperContexts: input.paperContexts,
          sections: input.sections,
          maxNotes: input.maxNotes,
          maxAnnotations: input.maxAnnotations,
        }),
        warnings: [],
      };
    },
  };
}
