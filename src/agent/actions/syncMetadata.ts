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

type SyncMetadataInput = {
  scope?: "all" | "collection";
  collectionId?: number;
};

type SyncMetadataOutput = {
  scanned: number;
  withIdentifier: number;
  updated: number;
  skipped: number;
  errors: number;
};

/**
 * Fetches canonical metadata for library items using Zotero's translator engine
 * (via DOI, arXiv ID, or title-based lookup), then fills in missing fields and
 * presents a before/after diff for user review before applying changes.
 *
 * Supports items with DOI, arXiv ID, or just a title — not limited to DOI-only items.
 */
export const syncMetadataAction: AgentAction<
  SyncMetadataInput,
  SyncMetadataOutput
> = {
  name: "sync_metadata",
  description:
    "Fetch canonical metadata from Zotero translators, CrossRef, and Semantic Scholar for library items. " +
    "Supports items with DOI, arXiv ID, or title. " +
    "Shows a before/after diff and applies missing fields after user approval.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which items to sync. Default: 'all'.",
      },
      collectionId: {
        type: "number",
        description: "Required when scope is 'collection'.",
      },
    },
  },

  async execute(
    input: SyncMetadataInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<SyncMetadataOutput>> {
    const STEPS = 3;
    let step = 0;

    // Step 1: query items with metadata
    ctx.onProgress({
      type: "step_start",
      step: "Querying library items",
      index: ++step,
      total: STEPS,
    });

    const queryArgs: Record<string, unknown> = {
      entity: "items",
      mode: "list",
      include: ["metadata"],
    };
    if (input.scope === "collection" && input.collectionId) {
      queryArgs.filters = { collectionId: input.collectionId };
    }

    const queryResult = await callTool(
      "query_library",
      queryArgs,
      ctx,
      "Querying library items",
    );
    if (!queryResult.ok) {
      return {
        ok: false,
        error: `Failed to query library: ${JSON.stringify(queryResult.content)}`,
      };
    }

    const content = queryResult.content as Record<string, unknown>;
    const allItems = Array.isArray(content.results) ? content.results : [];

    type ItemCandidate = {
      itemId: number;
      doi?: string;
      title?: string;
      currentMeta: unknown;
    };
    const candidates: ItemCandidate[] = [];
    for (const item of allItems) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const itemId = typeof record.itemId === "number" ? record.itemId : null;
      if (!itemId) continue;
      const meta = record.metadata;
      const doi =
        getMetadataField(meta, "DOI")?.replace(/^https?:\/\/doi\.org\//i, "") ||
        undefined;
      const title = getMetadataTitle(meta) || undefined;
      if (doi || title) {
        candidates.push({ itemId, doi, title, currentMeta: meta });
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Querying library items",
      summary: `${candidates.length} of ${allItems.length} items have a DOI or title`,
    });

    if (!candidates.length) {
      return {
        ok: true,
        output: {
          scanned: allItems.length,
          withIdentifier: 0,
          updated: 0,
          skipped: 0,
          errors: 0,
        },
      };
    }

    // Step 2: fetch canonical metadata for each item
    ctx.onProgress({
      type: "step_start",
      step: "Fetching canonical metadata",
      index: ++step,
      total: STEPS,
    });

    type UpdateCandidate = {
      itemId: number;
      patch: EditableArticleMetadataPatch;
      currentMeta: unknown;
      externalTitle: string;
    };
    const updateCandidates: UpdateCandidate[] = [];
    let errorCount = 0;

    for (const { itemId, doi, title, currentMeta } of candidates) {
      const label = doi
        ? `DOI: ${doi}`
        : `title: ${(title || "").slice(0, 50)}`;
      ctx.onProgress({
        type: "status",
        message: `Fetching metadata for ${label}`,
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
        `Fetching metadata for ${label}`,
      );

      if (!metaResult.ok) {
        errorCount++;
        continue;
      }

      const metaContent = metaResult.content as Record<string, unknown>;
      const results = Array.isArray(metaContent.results)
        ? metaContent.results
        : [];
      const externalMeta = results[0] as Record<string, unknown> | undefined;
      if (!externalMeta) continue;

      // The patch is built at the source (literatureSearchService) — just read it.
      // Only fill in fields that are currently empty in Zotero.
      const sourcePatch = externalMeta.patch as
        | EditableArticleMetadataPatch
        | undefined;
      if (!sourcePatch || Object.keys(sourcePatch).length === 0) continue;

      const patch: EditableArticleMetadataPatch = {};
      for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
        const currentValue = getMetadataField(currentMeta, fieldName);
        const newValue = sourcePatch[fieldName as EditableArticleMetadataField];
        if (!currentValue && newValue) {
          patch[fieldName as EditableArticleMetadataField] = newValue;
        }
      }
      if (!hasMetadataCreators(currentMeta) && sourcePatch.creators?.length) {
        patch.creators = sourcePatch.creators;
      }

      if (Object.keys(patch).length > 0) {
        updateCandidates.push({
          itemId,
          patch,
          currentMeta,
          externalTitle:
            typeof externalMeta.displayTitle === "string"
              ? externalMeta.displayTitle
              : sourcePatch.title || String(itemId),
        });
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Fetching canonical metadata",
      summary: `${updateCandidates.length} items have updatable fields`,
    });

    if (!updateCandidates.length) {
      return {
        ok: true,
        output: {
          scanned: allItems.length,
          withIdentifier: candidates.length,
          updated: 0,
          skipped: candidates.length,
          errors: errorCount,
        },
      };
    }

    // Step 3: apply updates via update_metadata (with HITL diff review)
    ctx.onProgress({
      type: "step_start",
      step: "Applying metadata updates",
      index: ++step,
      total: STEPS,
    });

    const operations = updateCandidates.map(({ itemId, patch }) => ({
      type: "update_metadata" as const,
      itemId,
      metadata: patch,
    }));

    const mutateResult = await callTool(
      "update_metadata",
      { operations },
      ctx,
      "Updating metadata",
    );

    const mutateContent = mutateResult.content as Record<string, unknown>;
    const succeeded = mutateResult.ok
      ? Number(
          mutateContent.appliedCount ||
            (Array.isArray(mutateContent.results)
              ? mutateContent.results.length
              : updateCandidates.length),
        )
      : 0;
    const denied = mutateResult.ok ? 0 : updateCandidates.length;

    ctx.onProgress({
      type: "step_done",
      step: "Applying metadata updates",
      summary: mutateResult.ok
        ? `Updated ${succeeded} item${succeeded === 1 ? "" : "s"}`
        : `Update was denied or failed`,
    });

    return {
      ok: true,
      output: {
        scanned: allItems.length,
        withIdentifier: candidates.length,
        updated: succeeded,
        skipped: candidates.length - updateCandidates.length + denied,
        errors: errorCount,
      },
    };
  },
};
