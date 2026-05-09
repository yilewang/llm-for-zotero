import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";
import type {
  EditableArticleMetadataPatch,
  EditableArticleMetadataField,
} from "../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../services/zoteroGateway";
import { callTool } from "./executor";
import {
  getMetadataField,
  getMetadataTitle,
  hasMetadataCreators,
} from "./metadataSnapshot";

type CompleteMetadataInput = {
  itemId: number;
};

type CompleteMetadataOutput = {
  title: string;
  missingFields: string[];
  updated: boolean;
  patchedFields: string[];
};

/**
 * Audits and completes metadata for a single paper.
 * First identifies missing fields, then fetches canonical metadata
 * from external sources and applies fixes with HITL review.
 */
export const completeMetadataAction: AgentAction<
  CompleteMetadataInput,
  CompleteMetadataOutput
> = {
  name: "complete_metadata",
  modes: ["paper"],
  description:
    "Audit and complete metadata for the current paper. " +
    "Identifies missing fields (abstract, DOI, tags, PDF), fetches canonical metadata, " +
    "and applies fixes after user review.",
  inputSchema: {
    type: "object",
    required: ["itemId"],
    additionalProperties: false,
    properties: {
      itemId: {
        type: "number",
        description: "The Zotero item ID of the paper to complete.",
      },
    },
  },

  async execute(
    input: CompleteMetadataInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<CompleteMetadataOutput>> {
    const STEPS = 3;
    let step = 0;

    // Step 1: Read current item metadata
    ctx.onProgress({
      type: "step_start",
      step: "Reading paper metadata",
      index: ++step,
      total: STEPS,
    });

    const readResult = await callTool(
      "read_library",
      {
        itemIds: [input.itemId],
        sections: ["metadata", "tags", "attachments"],
      },
      ctx,
      `Reading metadata for item ${input.itemId}`,
    );

    if (!readResult.ok) {
      return {
        ok: false,
        error: `Failed to read item: ${JSON.stringify(readResult.content)}`,
      };
    }

    const readContent = readResult.content as Record<string, unknown>;
    const readResults =
      readContent.results &&
      typeof readContent.results === "object" &&
      !Array.isArray(readContent.results)
        ? (readContent.results as Record<string, Record<string, unknown>>)
        : {};
    const itemEntry = readResults[String(input.itemId)] as
      | Record<string, unknown>
      | undefined;
    const meta = itemEntry?.metadata;
    const title = getMetadataTitle(meta) || `Item ${input.itemId}`;

    // Audit: identify missing fields
    const missingFields: string[] = [];
    if (!getMetadataField(meta, "abstractNote")) missingFields.push("abstract");
    if (!getMetadataField(meta, "DOI") && !getMetadataField(meta, "url")) {
      missingFields.push("DOI/URL");
    }
    const tags = Array.isArray(itemEntry?.tags) ? itemEntry!.tags : [];
    if (tags.length === 0) missingFields.push("tags");
    const attachments = Array.isArray(itemEntry?.attachments)
      ? itemEntry!.attachments
      : [];
    const hasPdf = attachments.some(
      (att: unknown) =>
        att &&
        typeof att === "object" &&
        (att as Record<string, unknown>).contentType === "application/pdf",
    );
    if (!hasPdf) missingFields.push("PDF");

    ctx.onProgress({
      type: "step_done",
      step: "Reading paper metadata",
      summary: missingFields.length
        ? `Missing: ${missingFields.join(", ")}`
        : "All metadata fields present",
    });

    if (missingFields.length === 0) {
      return {
        ok: true,
        output: { title, missingFields: [], updated: false, patchedFields: [] },
      };
    }

    // Step 2: Fetch canonical metadata
    ctx.onProgress({
      type: "step_start",
      step: "Fetching canonical metadata",
      index: ++step,
      total: STEPS,
    });

    const doi =
      getMetadataField(meta, "DOI")?.replace(/^https?:\/\/doi\.org\//i, "") ||
      undefined;
    const searchArgs: Record<string, unknown> = {
      mode: "metadata",
      libraryID: ctx.libraryID,
    };
    if (doi) {
      searchArgs.doi = doi;
    } else if (title) {
      searchArgs.title = title;
    }

    const metaResult = await callTool(
      "search_literature_online",
      searchArgs,
      ctx,
      `Fetching metadata for "${title}"`,
    );

    if (!metaResult.ok) {
      ctx.onProgress({
        type: "step_done",
        step: "Fetching canonical metadata",
        summary: "Could not find external metadata",
      });
      return {
        ok: true,
        output: { title, missingFields, updated: false, patchedFields: [] },
      };
    }

    const metaContent = metaResult.content as Record<string, unknown>;
    const results = Array.isArray(metaContent.results)
      ? metaContent.results
      : [];
    const externalMeta = results[0] as Record<string, unknown> | undefined;

    if (!externalMeta) {
      ctx.onProgress({
        type: "step_done",
        step: "Fetching canonical metadata",
        summary: "No results from external sources",
      });
      return {
        ok: true,
        output: { title, missingFields, updated: false, patchedFields: [] },
      };
    }

    // Build patch — only fill in fields that are currently empty
    const sourcePatch = externalMeta.patch as
      | EditableArticleMetadataPatch
      | undefined;
    if (!sourcePatch || Object.keys(sourcePatch).length === 0) {
      ctx.onProgress({
        type: "step_done",
        step: "Fetching canonical metadata",
        summary: "External metadata has no additional fields",
      });
      return {
        ok: true,
        output: { title, missingFields, updated: false, patchedFields: [] },
      };
    }

    const patch: EditableArticleMetadataPatch = {};
    for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
      const currentValue = getMetadataField(meta, fieldName);
      const newValue = sourcePatch[fieldName as EditableArticleMetadataField];
      if (!currentValue && newValue) {
        patch[fieldName as EditableArticleMetadataField] = newValue;
      }
    }
    if (!hasMetadataCreators(meta) && sourcePatch.creators?.length) {
      patch.creators = sourcePatch.creators;
    }

    const patchedFields = Object.keys(patch);

    ctx.onProgress({
      type: "step_done",
      step: "Fetching canonical metadata",
      summary: patchedFields.length
        ? `Can fill: ${patchedFields.join(", ")}`
        : "No new fields to fill",
    });

    if (patchedFields.length === 0) {
      return {
        ok: true,
        output: { title, missingFields, updated: false, patchedFields: [] },
      };
    }

    // Step 3: Apply updates with HITL review
    ctx.onProgress({
      type: "step_start",
      step: "Applying metadata updates",
      index: ++step,
      total: STEPS,
    });

    const operations = [
      {
        type: "update_metadata" as const,
        itemId: input.itemId,
        metadata: patch,
      },
    ];

    const mutateResult = await callTool(
      "update_metadata",
      { operations },
      ctx,
      "Updating metadata",
    );

    const updated = mutateResult.ok;

    ctx.onProgress({
      type: "step_done",
      step: "Applying metadata updates",
      summary: updated
        ? `Updated ${patchedFields.length} field${patchedFields.length === 1 ? "" : "s"}`
        : "Update was denied or failed",
    });

    return {
      ok: true,
      output: {
        title,
        missingFields,
        updated,
        patchedFields: updated ? patchedFields : [],
      },
    };
  },
};
