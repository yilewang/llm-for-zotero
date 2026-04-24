import type { AgentAction, ActionExecutionContext, ActionResult } from "./types";
import type {
  EditableArticleMetadataPatch,
  EditableArticleMetadataField,
} from "../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../services/zoteroGateway";
import { callTool } from "./executor";
import {
  resolvePaperScopedActionTargets,
  type PaperScopedActionInput,
  type PaperScopedActionProfile,
  type PaperScopedActionTarget,
} from "./paperScope";
import {
  getMetadataField,
  getMetadataTitle,
  hasMetadataCreators,
} from "./metadataSnapshot";

type CompleteMetadataInput = PaperScopedActionInput;

type CompleteMetadataItemOutput = {
  itemId: number;
  title: string;
  missingFields: string[];
  patchedFields: string[];
  updated: boolean;
};

type CompleteMetadataOutput = {
  targeted: number;
  updated: number;
  skipped: number;
  errors: number;
  items: CompleteMetadataItemOutput[];
};

type MetadataReadEntry = {
  itemId: number;
  title: string;
  metadata: unknown;
  tags: unknown[];
  attachments: unknown[];
};

type UpdateCandidate = {
  itemId: number;
  title: string;
  missingFields: string[];
  patchedFields: string[];
  patch: EditableArticleMetadataPatch;
};

const completeMetadataPaperScopeProfile: PaperScopedActionProfile = {
  targetMode: "single_or_multi",
  allowedScopes: ["current", "selection", "collection", "all"],
  defaultEmptyInput: "selection_or_prompt",
  paperRequirement: "bibliographic",
  supportsLimit: true,
  scopePromptOptions: {
    first: {
      label: "First 20 papers",
      input: { scope: "all", limit: 20 },
    },
    all: {
      label: "Whole library",
      input: { scope: "all" },
    },
  },
};

export const completeMetadataAction: AgentAction<
  CompleteMetadataInput,
  CompleteMetadataOutput
> = {
  name: "complete_metadata",
  modes: ["paper", "library"],
  paperScopeProfile: completeMetadataPaperScopeProfile,
  description:
    "Audit targeted papers for missing bibliographic metadata, fetch canonical metadata from external sources, " +
    "and open one review card with the proposed field updates.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      itemId: {
        type: "number",
        description: "Single Zotero paper item ID to target.",
      },
      itemIds: {
        type: "array",
        items: { type: "number" },
        description: "Explicit Zotero paper item IDs to target.",
      },
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which papers to consider when explicit itemIds/collectionIds are not provided.",
      },
      collectionId: {
        type: "number",
        description: "Single collection ID to target.",
      },
      collectionIds: {
        type: "array",
        items: { type: "number" },
        description: "Collection IDs to target.",
      },
      limit: {
        type: "number",
        description: "Max number of targeted papers to include in this run.",
      },
    },
  },

  async execute(
    input: CompleteMetadataInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<CompleteMetadataOutput>> {
    const STEPS = 4;
    let step = 0;

    ctx.onProgress({
      type: "step_start",
      step: "Resolving target papers",
      index: ++step,
      total: STEPS,
    });

    const targets = await resolvePaperScopedActionTargets(
      input,
      ctx,
      completeMetadataPaperScopeProfile,
    );

    ctx.onProgress({
      type: "step_done",
      step: "Resolving target papers",
      summary: `${targets.length} paper${targets.length === 1 ? "" : "s"} targeted`,
    });

    if (!targets.length) {
      return {
        ok: true,
        output: {
          targeted: 0,
          updated: 0,
          skipped: 0,
          errors: 0,
          items: [],
        },
      };
    }

    ctx.onProgress({
      type: "step_start",
      step: "Reading paper metadata",
      index: ++step,
      total: STEPS,
    });

    const readEntries = await readMetadataEntries(targets, ctx);

    ctx.onProgress({
      type: "step_done",
      step: "Reading paper metadata",
      summary: `Loaded ${readEntries.length}/${targets.length} paper metadata snapshots`,
    });

    ctx.onProgress({
      type: "step_start",
      step: "Fetching canonical metadata",
      index: ++step,
      total: STEPS,
    });

    const updateCandidates: UpdateCandidate[] = [];
    const itemOutputs = new Map<number, CompleteMetadataItemOutput>();
    let errorCount = 0;

    for (const entry of readEntries) {
      const missingFields = detectMissingFields(entry);
      const initialOutput: CompleteMetadataItemOutput = {
        itemId: entry.itemId,
        title: entry.title,
        missingFields,
        patchedFields: [],
        updated: false,
      };
      itemOutputs.set(entry.itemId, initialOutput);

      if (!missingFields.length) {
        continue;
      }

      const doi = getMetadataField(entry.metadata, "DOI")
        ?.replace(/^https?:\/\/doi\.org\//i, "") || undefined;
      const title = getMetadataTitle(entry.metadata) || entry.title;
      if (!doi && !title) {
        continue;
      }

      ctx.onProgress({
        type: "status",
        message: doi
          ? `Fetching metadata for DOI: ${doi}`
          : `Fetching metadata for title: ${title.slice(0, 60)}`,
      });

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
        errorCount++;
        continue;
      }

      const metaContent = metaResult.content as Record<string, unknown>;
      const results = Array.isArray(metaContent.results) ? metaContent.results : [];
      const externalMeta = results[0] as Record<string, unknown> | undefined;
      if (!externalMeta) continue;

      const patch = buildMetadataPatch(entry.metadata, externalMeta.patch);
      const patchedFields = Object.keys(patch);
      if (!patchedFields.length) continue;

      updateCandidates.push({
        itemId: entry.itemId,
        title: entry.title,
        missingFields,
        patchedFields,
        patch,
      });
      itemOutputs.set(entry.itemId, {
        ...initialOutput,
        patchedFields,
      });
    }

    ctx.onProgress({
      type: "step_done",
      step: "Fetching canonical metadata",
      summary: `${updateCandidates.length} paper${updateCandidates.length === 1 ? "" : "s"} have updatable fields`,
    });

    if (!updateCandidates.length) {
      return {
        ok: true,
        output: {
          targeted: targets.length,
          updated: 0,
          skipped: targets.length,
          errors: errorCount,
          items: targets.map((target) => itemOutputs.get(target.itemId) || {
            itemId: target.itemId,
            title: target.title,
            missingFields: [],
            patchedFields: [],
            updated: false,
          }),
        },
      };
    }

    ctx.onProgress({
      type: "step_start",
      step: "Applying metadata updates",
      index: ++step,
      total: STEPS,
    });

    const operations = updateCandidates.map((candidate) => ({
      type: "update_metadata" as const,
      itemId: candidate.itemId,
      metadata: candidate.patch,
    }));

    const mutateResult = await callTool(
      "update_metadata",
      { operations },
      ctx,
      "Updating metadata",
    );

    const mutateContent = mutateResult.content as Record<string, unknown>;
    const updatedCount = mutateResult.ok
      ? Number(
          mutateContent.appliedCount ||
          (Array.isArray(mutateContent.results) ? mutateContent.results.length : updateCandidates.length),
        )
      : 0;

    if (mutateResult.ok) {
      for (const candidate of updateCandidates) {
        itemOutputs.set(candidate.itemId, {
          itemId: candidate.itemId,
          title: candidate.title,
          missingFields: candidate.missingFields,
          patchedFields: candidate.patchedFields,
          updated: true,
        });
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Applying metadata updates",
      summary: mutateResult.ok
        ? `Updated ${updatedCount} paper${updatedCount === 1 ? "" : "s"}`
        : "Update was denied or failed",
    });

    return {
      ok: true,
      output: {
        targeted: targets.length,
        updated: updatedCount,
        skipped: Math.max(0, targets.length - updatedCount),
        errors: errorCount,
        items: targets.map((target) => itemOutputs.get(target.itemId) || {
          itemId: target.itemId,
          title: target.title,
          missingFields: [],
          patchedFields: [],
          updated: false,
        }),
      },
    };
  },
};

async function readMetadataEntries(
  targets: PaperScopedActionTarget[],
  ctx: ActionExecutionContext,
): Promise<MetadataReadEntry[]> {
  const readResult = await callTool(
    "read_library",
    {
      itemIds: targets.map((target) => target.itemId),
      sections: ["metadata", "tags", "attachments"],
    },
    ctx,
    `Reading metadata for ${targets.length} paper${targets.length === 1 ? "" : "s"}`,
  );

  if (!readResult.ok) {
    throw new Error(`Failed to read targeted papers: ${JSON.stringify(readResult.content)}`);
  }

  const readContent = readResult.content as Record<string, unknown>;
  const readResults =
    readContent.results &&
    typeof readContent.results === "object" &&
    !Array.isArray(readContent.results)
      ? (readContent.results as Record<string, Record<string, unknown>>)
      : {};

  return targets.map((target) => {
    const itemEntry = readResults[String(target.itemId)] as Record<string, unknown> | undefined;
    return {
      itemId: target.itemId,
      title: getMetadataTitle(itemEntry?.metadata) || target.title || `Item ${target.itemId}`,
      metadata: itemEntry?.metadata,
      tags: Array.isArray(itemEntry?.tags) ? itemEntry.tags : [],
      attachments: Array.isArray(itemEntry?.attachments) ? itemEntry.attachments : [],
    };
  });
}

function detectMissingFields(entry: MetadataReadEntry): string[] {
  const missingFields: string[] = [];
  if (!getMetadataField(entry.metadata, "abstractNote")) missingFields.push("abstract");
  if (!getMetadataField(entry.metadata, "DOI") && !getMetadataField(entry.metadata, "url")) {
    missingFields.push("DOI/URL");
  }
  if (!hasMetadataCreators(entry.metadata)) {
    missingFields.push("authors");
  }
  if (!entry.tags.length) {
    missingFields.push("tags");
  }
  const hasPdf = entry.attachments.some(
    (attachment) =>
      attachment &&
      typeof attachment === "object" &&
      (attachment as Record<string, unknown>).contentType === "application/pdf",
  );
  if (!hasPdf) {
    missingFields.push("PDF");
  }
  return missingFields;
}

function buildMetadataPatch(
  currentMetadata: unknown,
  rawPatch: unknown,
): EditableArticleMetadataPatch {
  const sourcePatch = rawPatch as EditableArticleMetadataPatch | undefined;
  if (!sourcePatch || Object.keys(sourcePatch).length === 0) {
    return {};
  }

  const patch: EditableArticleMetadataPatch = {};
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    const currentValue = getMetadataField(currentMetadata, fieldName);
    const newValue = sourcePatch[fieldName as EditableArticleMetadataField];
    if (!currentValue && newValue) {
      patch[fieldName as EditableArticleMetadataField] = newValue;
    }
  }
  if (!hasMetadataCreators(currentMetadata) && sourcePatch.creators?.length) {
    patch.creators = sourcePatch.creators;
  }
  return patch;
}
