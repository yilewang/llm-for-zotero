import type { PaperContextRef } from "../../../shared/types";
import {
  hasNoteEmbedTokens,
  NOTE_EMBED_PLACEHOLDER_GUIDANCE,
} from "../../../utils/noteEmbeds";
import type { AgentToolDefinition } from "../../types";
import {
  LibraryReadService,
  type ReadLibrarySection,
} from "../../services/libraryReadService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";

type ReadLibraryInput = {
  itemIds?: number[];
  paperContexts?: PaperContextRef[];
  selectorMode: "explicit" | "ambient";
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
  "relatedLinks",
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

function normalizeExplicitItemIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (
    value.some(
      (entry) =>
        typeof entry !== "number" ||
        !Number.isFinite(entry) ||
        entry <= 0 ||
        !Number.isInteger(entry),
    )
  ) {
    return null;
  }
  return Array.from(new Set(value));
}

function normalizeExplicitPaperContexts(
  value: unknown,
): PaperContextRef[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const contexts = value
    .map((entry) =>
      validateObject<Record<string, unknown>>(entry)
        ? normalizeToolPaperContext(entry)
        : null,
    )
    .filter(
      (
        entry,
      ): entry is NonNullable<ReturnType<typeof normalizeToolPaperContext>> =>
        Boolean(entry),
    );
  return contexts.length === value.length ? contexts : null;
}

export function createLibraryReadTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ReadLibraryInput, unknown> {
  const readService = new LibraryReadService(zoteroGateway);
  return {
    spec: {
      name: "library_read",
      description:
        "Read structured Zotero item state: metadata, notes, annotations, attachments, collection membership, relatedLinks (Zotero's Related box), and note content. Use paper_read for primary PDF/paper content. For explicit child-attachment requests, enumerate attachments then use read_attachment for Markdown/HTML/TXT/DOCX.",
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
            description:
              "Paper context references. Alternative to itemIds for targeting papers.",
            items: PAPER_CONTEXT_REF_SCHEMA,
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
                "relatedLinks",
              ],
            },
          },
          maxNotes: { type: "number" },
          maxAnnotations: { type: "number" },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: {
      label: "Read Library",
      traceIcon: "library",
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
        const rawSections = Array.isArray(args.sections) ? args.sections : [];
        if (!rawSections.length) {
          return fail(
            "sections is required: provide an array like ['metadata', 'notes']. " +
              "Valid sections: metadata, notes, content, annotations, attachments, collections, relatedLinks.",
          );
        }
        return fail(
          `None of the provided sections are valid: ${JSON.stringify(rawSections.slice(0, 5))}. ` +
            `Valid sections: metadata, notes, content, annotations, attachments, collections, relatedLinks.` +
            (rawSections.includes("tags")
              ? " Item tags come from library_search with include:['tags']."
              : ""),
        );
      }
      const hasItemIds = Object.prototype.hasOwnProperty.call(args, "itemIds");
      const hasPaperContexts = Object.prototype.hasOwnProperty.call(
        args,
        "paperContexts",
      );
      const itemIds = hasItemIds
        ? normalizeExplicitItemIds(args.itemIds)
        : undefined;
      if (hasItemIds && !itemIds) {
        return fail(
          "itemIds must be a non-empty array of positive integer Zotero item IDs",
        );
      }
      const paperContexts = hasPaperContexts
        ? normalizeExplicitPaperContexts(args.paperContexts)
        : undefined;
      if (hasPaperContexts && !paperContexts) {
        return fail(
          "paperContexts must be a non-empty array of complete paper context references",
        );
      }
      return ok<ReadLibraryInput>({
        itemIds: itemIds || undefined,
        paperContexts: paperContexts || undefined,
        selectorMode: hasItemIds || hasPaperContexts ? "explicit" : "ambient",
        sections,
        maxNotes: normalizePositiveInt(args.maxNotes),
        maxAnnotations: normalizePositiveInt(args.maxAnnotations),
      });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: ["zotero_library"],
        reason:
          "The library reader exposes Zotero item state without mutating it.",
      }),
    execute: async (input, context) => {
      const read = await readService.readItems({
        request: context.request,
        itemIds: input.itemIds,
        paperContexts: input.paperContexts,
        selectorMode: input.selectorMode,
        sections: input.sections,
        maxNotes: input.maxNotes,
        maxAnnotations: input.maxAnnotations,
      });
      return {
        sections: input.sections,
        results: read.results,
        warnings: read.warnings,
        // Explain note placeholders once, and only when a note has them.
        ...(hasNoteEmbedTokens(JSON.stringify(read.results))
          ? { noteEmbeds: NOTE_EMBED_PLACEHOLDER_GUIDANCE }
          : {}),
      };
    },
  };
}
