import type { AgentAction, ActionExecutionContext, ActionResult } from "./types";
import { callTool } from "./executor";
import { getMetadataField } from "./metadataSnapshot";

type DiscoverRelatedInput = {
  itemId: number;
  mode?: "recommendations" | "references" | "citations";
  source?: "openalex" | "arxiv" | "europepmc";
  limit?: number;
};

type DiscoverRelatedOutput = {
  seedTitle: string;
  discovered: number;
  imported: number;
};

/**
 * Finds papers related to a given Zotero item (via recommendations, references,
 * or citations), presents the results for review, and imports selected papers.
 */
export const discoverRelatedAction: AgentAction<DiscoverRelatedInput, DiscoverRelatedOutput> = {
  name: "discover_related",
  modes: ["paper"],
  description:
    "Find papers related to a specific Zotero item using OpenAlex recommendations, " +
    "references, or citations. Presents results for review and imports the selected papers.",
  inputSchema: {
    type: "object",
    required: ["itemId"],
    additionalProperties: false,
    properties: {
      itemId: {
        type: "number",
        description: "The Zotero item ID of the seed paper.",
      },
      mode: {
        type: "string",
        enum: ["recommendations", "references", "citations"],
        description: "Discovery mode. Default: 'recommendations'.",
      },
      source: {
        type: "string",
        enum: ["openalex"],
        description: "Search source. Only OpenAlex supports recommendations, references, and citations.",
      },
      limit: {
        type: "number",
        description:
          "Max number of related papers to retrieve per mode. Default: 20. " +
          "Invoke as `/discover_related 30` (or any number) to override.",
      },
    },
  },

  async execute(
    input: DiscoverRelatedInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<DiscoverRelatedOutput>> {
    const STEPS = 3;
    let step = 0;
    const defaultMode = input.mode || "recommendations";

    // Step 1: get seed item metadata
    ctx.onProgress({
      type: "step_start",
      step: "Reading seed paper",
      index: ++step,
      total: STEPS,
    });

    const readResult = await callTool(
      "read_library",
      { itemIds: [input.itemId], sections: ["metadata"] },
      ctx,
      `Reading metadata for item ${input.itemId}`,
    );

    const readContent = readResult.ok
      ? (readResult.content as Record<string, unknown>)
      : {};
    const readResults =
      readContent.results &&
      typeof readContent.results === "object" &&
      !Array.isArray(readContent.results)
        ? (readContent.results as Record<string, Record<string, unknown>>)
        : {};
    const seedEntry = readResults[String(input.itemId)] as Record<string, unknown> | undefined;
    const seedMeta = seedEntry?.metadata;
    const seedTitle =
      getMetadataField(seedMeta, "title") || `Item ${input.itemId}`;
    const seedDoi = getMetadataField(seedMeta, "DOI");

    ctx.onProgress({
      type: "step_done",
      step: "Reading seed paper",
      summary: seedTitle,
    });

    // Step 2: fetch all three discovery modes in parallel so the review card
    // can offer a Recommendations / References / Citations toggle without
    // additional round-trips when the user switches.
    ctx.onProgress({
      type: "step_start",
      step: "Finding related papers",
      index: ++step,
      total: STEPS,
    });

    type SearchMode = "recommendations" | "references" | "citations";
    type PaperRow = {
      id: string;
      title: string;
      subtitle?: string;
      badges?: string[];
      href?: string;
      importIdentifier?: string;
      year?: number;
      citationCount?: number;
      checked?: boolean;
    };

    const initialLimit = input.limit || 20;
    const loadMoreIncrement = 20;
    const source = input.source || "openalex";

    type FetchModeResult = { rows: PaperRow[]; failed: boolean; error?: string };

    const fetchMode = async (
      mode: SearchMode,
      limit: number,
    ): Promise<FetchModeResult> => {
      const result = await callTool(
        "search_literature_online",
        {
          mode,
          itemId: input.itemId,
          doi: seedDoi,
          source,
          limit,
          libraryID: ctx.libraryID,
        },
        ctx,
        `Finding ${mode} for "${seedTitle}"`,
      );
      if (!result.ok) {
        const errContent = result.content as Record<string, unknown> | undefined;
        const errMsg =
          errContent && typeof errContent.error === "string"
            ? errContent.error
            : `search_literature_online failed for mode "${mode}"`;
        return { rows: [], failed: true, error: errMsg };
      }
      const content = result.content as Record<string, unknown>;
      const raw = Array.isArray(content.results) ? content.results : [];
      const rows = raw
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r, i) => buildPaperRow(r, i, mode));
      return { rows, failed: false };
    };

    const buildPaperRow = (
      r: Record<string, unknown>,
      i: number,
      mode: SearchMode,
    ): PaperRow => {
      const title = typeof r.title === "string" ? r.title : `Result ${i + 1}`;
      const authors = Array.isArray(r.authors)
        ? r.authors
            .filter((a): a is string => typeof a === "string")
            .slice(0, 3)
            .join(", ")
        : "";
      const year = r.year ? String(r.year) : "";
      const subtitle = [year, authors].filter(Boolean).join(" · ") || undefined;
      const doi =
        typeof r.doi === "string" && r.doi.trim()
          ? r.doi.trim().replace(/^https?:\/\/doi\.org\//i, "")
          : null;
      const arxivMatch =
        typeof r.sourceUrl === "string"
          ? /arxiv\.org\/abs\/([\d.]+)/i.exec(r.sourceUrl)?.[1]
          : null;
      const importIdentifier = doi?.startsWith("10.")
        ? doi
        : arxivMatch
          ? `arxiv:${arxivMatch}`
          : undefined;
      const badges: string[] = [];
      if (typeof r.citationCount === "number") badges.push(`${r.citationCount} citations`);
      if (doi) badges.push(`DOI: ${doi}`);
      return {
        // Mode-scoped ID avoids collision when the same paper shows up under
        // multiple modes (e.g. a cited paper that's also a recommendation).
        id: `${mode}-${i + 1}`,
        title,
        subtitle,
        badges: badges.length ? badges : undefined,
        href: typeof r.openAccessUrl === "string" ? r.openAccessUrl : undefined,
        importIdentifier,
        year: typeof r.year === "number" ? r.year : undefined,
        citationCount:
          typeof r.citationCount === "number" ? r.citationCount : undefined,
      };
    };

    // Fetch-and-review loop. Each iteration: fetch all three modes at the
    // current limit, show the review card, wait for the user. If they click
    // "Load more", bump the limit and re-enter the loop. Prior selections
    // (checkbox state) are preserved by reading them out of the resolution
    // data and re-marking the new row set before the next requestConfirmation.
    let currentLimit = initialLimit;
    let priorSelections = new Set<string>();
    let lastActiveModeId: string = defaultMode;
    let rec: PaperRow[] = [];
    let ref: PaperRow[] = [];
    let cit: PaperRow[] = [];
    let allRows: PaperRow[] = [];
    let totalDiscovered = 0;
    // Track which modes failed in the most recent fetchAllModes call so we
    // can distinguish "genuinely no related papers" from "every source
    // failed" (network/auth/rate-limit).
    let fetchFailures: { mode: SearchMode; error: string }[] = [];
    let resolution: Awaited<ReturnType<typeof ctx.requestConfirmation>>;

    const countUniqueDiscoveredRows = (rows: PaperRow[]): number => {
      const keys = new Set<string>();
      for (const row of rows) {
        const key =
          row.importIdentifier?.trim().toLowerCase() ||
          `${row.title.trim().toLowerCase()}:${row.subtitle || ""}`;
        if (key) keys.add(key);
      }
      return keys.size;
    };

    const extractFetchResult = (
      settled: PromiseSettledResult<FetchModeResult>,
      mode: SearchMode,
    ): FetchModeResult =>
      settled.status === "fulfilled"
        ? settled.value
        : {
            rows: [],
            failed: true,
            error:
              settled.reason instanceof Error
                ? settled.reason.message
                : String(settled.reason),
          };

    const fetchAllModes = async (limit: number) => {
      const [recSettled, refSettled, citSettled] = await Promise.allSettled([
        fetchMode("recommendations", limit),
        fetchMode("references", limit),
        fetchMode("citations", limit),
      ]);
      const recResult = extractFetchResult(recSettled, "recommendations");
      const refResult = extractFetchResult(refSettled, "references");
      const citResult = extractFetchResult(citSettled, "citations");
      rec = recResult.rows;
      ref = refResult.rows;
      cit = citResult.rows;
      allRows = [...rec, ...ref, ...cit];
      totalDiscovered = countUniqueDiscoveredRows(allRows);
      fetchFailures = [
        { mode: "recommendations" as const, result: recResult },
        { mode: "references" as const, result: refResult },
        { mode: "citations" as const, result: citResult },
      ]
        .filter((x) => x.result.failed)
        .map((x) => ({ mode: x.mode, error: x.result.error || "unknown error" }));
    };

    await fetchAllModes(currentLimit);

    ctx.onProgress({
      type: "step_done",
      step: "Finding related papers",
      summary: `Recommendations: ${rec.length} · References: ${ref.length} · Citations: ${cit.length}`,
    });

    // All three modes failed → surface the actual error instead of the
    // ambiguous "no related papers" empty-success path.
    if (fetchFailures.length === 3) {
      const firstError = fetchFailures[0].error;
      return {
        ok: false,
        error: `Failed to fetch related papers from ${source}: ${firstError}`,
      };
    }

    if (totalDiscovered === 0) {
      return { ok: true, output: { seedTitle, discovered: 0, imported: 0 } };
    }

    // Step 3: HITL paper selection + import (with optional Load more loop)
    ctx.onProgress({
      type: "step_start",
      step: "Reviewing and importing papers",
      index: ++step,
      total: STEPS,
    });

    // Hard cap on load_more iterations so a misbehaving UI can't spin the
    // action forever.
    const maxLoadMoreIterations = 10;

    for (let iter = 0; iter < maxLoadMoreIterations; iter += 1) {
      const requestId = `discover-related-${Date.now()}-${iter}`;

      // Apply prior selections: a row is pre-checked if either (a) it's a
      // fresh recommendations row on the first pass, or (b) its ID is in
      // priorSelections from a previous iteration.
      const markRows = (rows: PaperRow[], freshDefault: boolean) =>
        rows.map((p) => ({
          ...p,
          checked: priorSelections.has(p.id)
            ? true
            : iter === 0
              ? freshDefault
              : false,
        }));

      const reviewCard = {
        toolName: "discover_related",
        mode: "review" as const,
        title: `Related papers for "${seedTitle}"`,
        description:
          "Toggle between recommendations, references, and citations. Select the papers you want to import.",
        confirmLabel: "Import selected",
        cancelLabel: "Cancel",
        actions: [
          { id: "import", label: "Import selected", style: "primary" as const },
          { id: "cancel", label: "Cancel", style: "secondary" as const },
        ],
        defaultActionId: "import",
        cancelActionId: "cancel",
        fields: [
          {
            type: "paper_result_list" as const,
            id: "selectedPaperIds",
            label: "",
            rows: markRows(rec, true),
            modes: [
              {
                id: "recommendations",
                label: "Recommendations",
                rows: markRows(rec, true),
                emptyMessage:
                  "No recommendations available for this paper on OpenAlex.",
              },
              {
                id: "references",
                label: "References",
                rows: markRows(ref, false),
                emptyMessage:
                  "No reference list is available for this paper on OpenAlex.",
              },
              {
                id: "citations",
                label: "Citations",
                rows: markRows(cit, false),
                emptyMessage:
                  "This paper has no citing works on OpenAlex yet.",
              },
            ],
            defaultModeId: lastActiveModeId,
            loadMoreActionId: "load_more",
            loadMoreLabel: `Load ${loadMoreIncrement} more`,
            minSelectedByAction: [{ actionId: "import", min: 1 }],
          },
        ],
      };

      resolution = await ctx.requestConfirmation(requestId, reviewCard);

      if (resolution.actionId === "load_more") {
        // Preserve current selections + active mode for the next iteration.
        const data = (resolution.data || {}) as Record<string, unknown>;
        const ids = Array.isArray(data.selectedPaperIds)
          ? (data.selectedPaperIds as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : [];
        priorSelections = new Set(ids);
        const activeModeFromUi = data.__activeModeId__;
        if (typeof activeModeFromUi === "string") {
          lastActiveModeId = activeModeFromUi;
        }
        currentLimit += loadMoreIncrement;

        ctx.onProgress({
          type: "step_start",
          step: "Loading more related papers",
          index: step,
          total: STEPS,
        });
        await fetchAllModes(currentLimit);
        ctx.onProgress({
          type: "step_done",
          step: "Loading more related papers",
          summary: `Recommendations: ${rec.length} · References: ${ref.length} · Citations: ${cit.length}`,
        });
        continue; // re-issue the review card with the expanded row set
      }

      // Either import or cancel — exit the loop and handle below.
      break;
    }

    // Treat a cap-exit as cancel: if the last resolution is still "load_more"
    // when the loop's hard iteration cap is reached, the user never gave an
    // explicit import confirmation, so we must NOT fall through and import
    // whatever happened to be checked at that point.
    if (
      !resolution! ||
      !resolution.approved ||
      resolution.actionId === "cancel" ||
      resolution.actionId === "load_more"
    ) {
      return {
        ok: true,
        output: { seedTitle, discovered: totalDiscovered, imported: 0 },
      };
    }

    const finalData = (resolution.data || {}) as Record<string, unknown>;
    const rawSelectedIds = Array.isArray(finalData.selectedPaperIds)
      ? (finalData.selectedPaperIds as string[])
      : rec.map((p) => p.id);
    const selectedIds = rawSelectedIds.map((id) => {
      const legacyMatch = /^paper-(\d+)$/i.exec(id);
      if (!legacyMatch) return id;
      const legacyIndex = Number(legacyMatch[1]);
      return Number.isFinite(legacyIndex) && legacyIndex > 0
        ? allRows[legacyIndex - 1]?.id || id
        : id;
    });

    const selectedPapers = allRows.filter((p) => selectedIds.includes(p.id));
    const identifiers = Array.from(
      new Set(
        selectedPapers
          .map((p) => p.importIdentifier)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (!identifiers.length) {
      return {
        ok: true,
        output: { seedTitle, discovered: totalDiscovered, imported: 0 },
      };
    }

    const importResult = await callTool(
      "import_identifiers",
      {
        identifiers,
        libraryID: ctx.libraryID,
      },
      ctx,
      "Importing selected papers",
    );

    const importContent = importResult.content as Record<string, unknown>;
    const resultObj = importContent.result as Record<string, unknown> | undefined;
    const importedCount = importResult.ok && resultObj
      ? Number(resultObj.succeeded || resultObj.importedCount || 0)
      : 0;

    ctx.onProgress({
      type: "step_done",
      step: "Reviewing and importing papers",
      summary: importResult.ok
        ? `Imported ${importedCount} paper${importedCount === 1 ? "" : "s"}`
        : "Import was denied or failed",
    });

    return {
      ok: true,
      output: {
        seedTitle,
        discovered: totalDiscovered,
        imported: importedCount,
      },
    };
  },
};
