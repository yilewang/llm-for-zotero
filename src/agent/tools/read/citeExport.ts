/**
 * Formatted citations, bibliographies, and export.
 *
 * The most dangerous everyday gap in the capability census: asked for "the
 * APA reference for this paper" the agent had **no tool at all**, so it
 * produced a plausible-looking citation from memory. A fabricated reference
 * is worse than a refusal in a reference manager, and getting it right is the
 * one thing this product exists for. Export was equally unreachable — the
 * whole domain scored zero covered operations.
 */
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveIntArray } from "../shared";

type CiteExportInput = {
  action: "cite" | "bibliography" | "export" | "styles" | "formats";
  itemIds?: number[];
  styleId?: string;
  locale?: string;
  format?: "text" | "html";
  translatorId?: string;
};

export function createCiteExportTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<CiteExportInput, unknown> {
  return {
    spec: {
      name: "library_cite",
      description:
        "Format real citations and bibliographies through Zotero's own CSL engine, or export items with a Zotero translator. ALWAYS use this when the user asks for a citation, a reference, a bibliography, or a formatted entry in any style — never write one from memory, because a citation that looks right and is wrong is worse than saying you cannot produce it.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["cite", "bibliography", "export", "styles", "formats"],
            description:
              "'bibliography' formats full reference entries; 'cite' formats in-text citations; 'export' writes the items in a file format such as BibTeX; 'styles' lists installed citation styles; 'formats' lists export formats.",
          },
          itemIds: {
            type: "array",
            items: { type: "number" },
            description:
              "The items to cite or export. Required for cite, bibliography and export.",
          },
          styleId: {
            type: "string",
            description:
              "A citation style ID, e.g. 'http://www.zotero.org/styles/apa'. Defaults to the user's Quick Copy style. List them with action:'styles'.",
          },
          locale: {
            type: "string",
            description: "CSL locale, e.g. 'en-US'. Defaults to en-US.",
          },
          format: {
            type: "string",
            enum: ["text", "html"],
            default: "text",
          },
          translatorId: {
            type: "string",
            description:
              "The export translator ID, for action:'export'. List them with action:'formats'.",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },

    presentation: {
      label: "Cite / Export",
      summaries: {
        onCall: "Formatting references",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          if (Array.isArray(result.styles)) {
            return `Listed ${result.styles.length} citation styles`;
          }
          if (Array.isArray(result.formats)) {
            return `Listed ${result.formats.length} export formats`;
          }
          const count = Number(result.itemCount || 0);
          return count
            ? `Formatted ${count} reference${count === 1 ? "" : "s"}`
            : "Formatted references";
        },
      },
    },

    guidance: {
      matches: (request) =>
        /\b(cite|citation|citations|reference|references|bibliograph|apa|mla|chicago|harvard|vancouver|ieee|bibtex|biblatex|ris|csl|export)\b/i.test(
          request.userText || "",
        ),
      instruction:
        "When the user asks for a citation, a reference, or a bibliography in any style, call library_cite — do not compose one yourself. Zotero's CSL engine produces the correct entry for the style; a citation written from memory looks right and is frequently wrong in exactly the details that matter (author initials, page ranges, edition, container title). If the style they name is not installed, say so and list what is, rather than approximating it.",
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with an action. Example: { action: "bibliography", itemIds: [101] }',
        );
      }
      const action = args.action;
      if (
        action !== "cite" &&
        action !== "bibliography" &&
        action !== "export" &&
        action !== "styles" &&
        action !== "formats"
      ) {
        return fail(
          "action must be one of: cite, bibliography, export, styles, formats",
        );
      }
      const itemIds = normalizePositiveIntArray(args.itemIds);
      if (
        (action === "cite" ||
          action === "bibliography" ||
          action === "export") &&
        !itemIds?.length
      ) {
        return fail(
          `action "${action}" requires a non-empty itemIds array. Find them with library_search first.`,
        );
      }
      if (action === "export" && typeof args.translatorId !== "string") {
        return fail(
          'action "export" requires translatorId. List the options with { action: "formats" }.',
        );
      }
      return ok<CiteExportInput>({
        action,
        itemIds: itemIds || undefined,
        styleId:
          typeof args.styleId === "string" ? args.styleId.trim() : undefined,
        locale:
          typeof args.locale === "string" ? args.locale.trim() : undefined,
        format: args.format === "html" ? "html" : "text",
        translatorId:
          typeof args.translatorId === "string"
            ? args.translatorId.trim()
            : undefined,
      });
    },

    async execute(input) {
      if (input.action === "styles") {
        return { styles: zoteroGateway.listCitationStyles() };
      }
      if (input.action === "formats") {
        return { formats: zoteroGateway.listExportFormats() };
      }
      if (input.action === "export") {
        const result = await zoteroGateway.exportItems({
          itemIds: input.itemIds || [],
          translatorId: input.translatorId as string,
        });
        return { ...result, translatorId: input.translatorId };
      }
      return zoteroGateway.formatBibliography({
        itemIds: input.itemIds || [],
        styleId: input.styleId,
        locale: input.locale,
        format: input.format,
        mode: input.action === "cite" ? "citation" : "bibliography",
      });
    },
  };
}
