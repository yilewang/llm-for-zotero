import type {
  AgentConfirmationResolution,
  AgentModelMessage,
  AgentInheritedApproval,
  AgentPendingAction,
  AgentPendingField,
  AgentToolContext,
  AgentToolReviewResolution,
  AgentToolResult,
} from "./types";
import { normalizeNoteSourceText } from "../modules/contextPanel/notes";
import type {
  EditableArticleMetadataPatch,
  EditableArticleMetadataField,
} from "./services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "./services/zoteroGateway";
import type { PaperContextRef } from "../shared/types";
import { normalizeToolPaperContext } from "./tools/shared";
import {
  METADATA_FIELD_DISPLAY_LABELS,
  formatCreatorsDisplay,
} from "./tools/write/mutateLibraryShared";

type SearchLiteratureOnlineMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search"
  | "metadata";

type SearchLiteratureOnlineSource = "openalex" | "arxiv" | "europepmc";

type SearchReviewPaper = {
  rowId: string;
  title: string;
  subtitle?: string;
  body?: string;
  badges?: string[];
  href?: string;
  importIdentifier?: string;
  raw: Record<string, unknown>;
};

type SearchReviewMetadataRow = {
  key: string;
  label: string;
  before?: string;
  after: string;
  multiline?: boolean;
};

type SearchReviewMetadataChoice = {
  rowId: string;
  title: string;
  subtitle?: string;
  badge?: string;
  raw: Record<string, unknown>;
};

type SearchReviewPrepared =
  | {
      kind: "paper_results";
      mode: Exclude<SearchLiteratureOnlineMode, "metadata">;
      source?: string;
      query?: string;
      papers: SearchReviewPaper[];
    }
  | {
      kind: "metadata";
      mode: "metadata";
      rows: SearchReviewMetadataRow[];
      choices: SearchReviewMetadataChoice[];
      noteContent: string;
      /** Whether the best result has high-confidence match (translator or DOI). */
      highConfidence: boolean;
    };

type SearchReviewArgs = {
  mode?: SearchLiteratureOnlineMode;
  source?: SearchLiteratureOnlineSource;
  limit?: number;
  libraryID?: number;
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  title?: string;
  arxivId?: string;
  query?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function bareDoi(value: unknown): string | undefined {
  const doi = readString(value);
  if (!doi) return undefined;
  return doi.replace(/^https?:\/\/doi\.org\//i, "");
}

function maybeArxivIdentifier(url: unknown): string | undefined {
  const raw = readString(url);
  if (!raw) return undefined;
  const match = /arxiv\.org\/abs\/([\d.]+)/i.exec(raw);
  return match?.[1] ? `arxiv:${match[1]}` : undefined;
}

function buildImportIdentifier(result: Record<string, unknown>): string | undefined {
  const doi = bareDoi(result.doi);
  if (doi?.startsWith("10.")) return doi;
  return (
    maybeArxivIdentifier(result.sourceUrl) ||
    maybeArxivIdentifier(result.openAccessUrl)
  );
}

function buildPaperSubtitle(result: Record<string, unknown>): string | undefined {
  const year =
    typeof result.year === "number"
      ? String(result.year)
      : readString(result.year);
  const authors = Array.isArray(result.authors)
    ? result.authors
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 3)
    : [];
  const authorLabel =
    authors.length > 0
      ? `${authors.join(", ")}${Array.isArray(result.authors) && result.authors.length > 3 ? " et al." : ""}`
      : undefined;
  const parts = [year, authorLabel].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function buildPaperBadges(result: Record<string, unknown>): string[] | undefined {
  const badges: string[] = [];
  if (typeof result.citationCount === "number") {
    badges.push(
      `${result.citationCount.toLocaleString()} citation${
        result.citationCount === 1 ? "" : "s"
      }`,
    );
  }
  const doi = bareDoi(result.doi);
  if (doi) badges.push(`DOI: ${doi}`);
  return badges.length ? badges : undefined;
}

function describeMetadataResult(result: Record<string, unknown>): string {
  const patch = result.patch as Record<string, unknown> | undefined;
  const title = readString(result.displayTitle) || readString(patch?.title) || "Untitled result";
  const subtitle = readString(result.displaySubtitle) || "";
  const abstract = readString(patch?.abstractNote) || "";
  const abstractSnippet =
    abstract.length > 220 ? `${abstract.slice(0, 220).trimEnd()}...` : abstract;
  return [title, subtitle, abstractSnippet]
    .filter(Boolean)
    .join("\n");
}

function getReferencePaperTitle(context: AgentToolContext): string | undefined {
  return (
    context.request.selectedPaperContexts?.[0]?.title ||
    context.request.fullTextPaperContexts?.[0]?.title ||
    context.request.pinnedPaperContexts?.[0]?.title ||
    context.item?.getDisplayTitle?.() ||
    undefined
  );
}

function getReferencePaperContext(
  context: AgentToolContext,
): PaperContextRef | undefined {
  return (
    context.request.selectedPaperContexts?.[0] ||
    context.request.fullTextPaperContexts?.[0] ||
    context.request.pinnedPaperContexts?.[0] ||
    undefined
  );
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMetadataChoice(
  record: Record<string, unknown>,
  args: SearchReviewArgs,
  context: AgentToolContext,
): number {
  let score = 0;
  const patch = record.patch as Record<string, unknown> | undefined;
  const candidateDoi = bareDoi(patch?.DOI);
  const targetDoi = bareDoi(args.doi);
  if (candidateDoi && targetDoi && candidateDoi.toLowerCase() === targetDoi.toLowerCase()) {
    score += 100;
  }
  const candidateTitle = readString(record.displayTitle) || readString(patch?.title);
  const targetTitle = args.title || args.query || getReferencePaperTitle(context);
  if (candidateTitle && targetTitle) {
    const candidateKey = normalizeTitleKey(candidateTitle);
    const targetKey = normalizeTitleKey(targetTitle);
    if (candidateKey && targetKey) {
      if (candidateKey === targetKey) {
        score += 60;
      } else if (candidateKey.includes(targetKey) || targetKey.includes(candidateKey)) {
        score += 25;
      }
    }
  }
  const source = readString(record.source)?.toLowerCase();
  if (source === "zotero translator") {
    score += 10;
  } else if (source === "crossref") {
    score += 5;
  }
  return score;
}

function describeMetadataChoice(
  record: Record<string, unknown>,
): { title: string; subtitle?: string; badge?: string } {
  const patch = record.patch as Record<string, unknown> | undefined;
  const source = readString(record.source) || "Metadata result";
  const title = readString(record.displayTitle) || readString(patch?.title) || source;
  const subtitle = readString(record.displaySubtitle) ||
    [source].filter(Boolean).join(" · ") || undefined;
  const doi = bareDoi(patch?.DOI);
  return {
    title,
    subtitle,
    badge: doi ? `DOI: ${doi}` : undefined,
  };
}

function buildMetadataUpdatePatch(
  record: Record<string, unknown>,
): EditableArticleMetadataPatch | null {
  // The patch is built at the source (literatureSearchService) — just read it
  const patch = record.patch as EditableArticleMetadataPatch | undefined;
  return patch && Object.keys(patch).length > 0 ? patch : null;
}

function resolveMetadataChoice(
  prepared: Extract<SearchReviewPrepared, { kind: "metadata" }>,
  selectedRowId: string | undefined,
  args: SearchReviewArgs,
  context: AgentToolContext,
): SearchReviewMetadataChoice | null {
  if (selectedRowId) {
    const direct = prepared.choices.find((choice) => choice.rowId === selectedRowId);
    if (direct) return direct;
  }
  let best: SearchReviewMetadataChoice | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const choice of prepared.choices) {
    const score = scoreMetadataChoice(choice.raw, args, context);
    if (score > bestScore) {
      best = choice;
      bestScore = score;
    }
  }
  return best || prepared.choices[0] || null;
}

function buildMetadataChoiceOptions(
  prepared: Extract<SearchReviewPrepared, { kind: "metadata" }>,
  args: SearchReviewArgs,
  context: AgentToolContext,
): Array<{ id: string; label: string }> {
  const selected = resolveMetadataChoice(prepared, undefined, args, context);
  return prepared.choices.map((choice) => {
    const detail = [choice.title, choice.subtitle].filter(Boolean).join(" — ");
    return {
      id: choice.rowId,
      label: choice.rowId === selected?.rowId ? `${detail} (Recommended)` : detail,
    };
  });
}

function buildPaperNoteTemplate(
  context: AgentToolContext,
  prepared: Extract<SearchReviewPrepared, { kind: "paper_results" }>,
): string {
  const paperTitle = getReferencePaperTitle(context) || "Current paper";
  const header = `## Related papers for ${paperTitle}`;
  const detail = [
    prepared.source ? `Source: ${prepared.source}` : null,
    prepared.mode ? `Mode: ${prepared.mode}` : null,
    prepared.query ? `Query: ${prepared.query}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const items = prepared.papers
    .map((paper) => {
      const doi = paper.importIdentifier?.startsWith("10.")
        ? ` DOI: ${paper.importIdentifier}`
        : "";
      return `- ${paper.title}${paper.subtitle ? ` (${paper.subtitle})` : ""}${doi}`;
    })
    .join("\n");
  return [header, detail, "", items].filter(Boolean).join("\n");
}

function buildMetadataNoteTemplate(
  context: AgentToolContext,
  rows: SearchReviewMetadataRow[],
): string {
  const paperTitle = getReferencePaperTitle(context) || "Current paper";
  return [
    `## External metadata for ${paperTitle}`,
    "",
    ...rows.map((row) => `- ${row.label}: ${row.after}`),
  ].join("\n");
}

function buildNoteDraftReviewFields(noteContent: string): AgentPendingField[] {
  return [
    {
      type: "diff_preview",
      id: "noteDiff",
      label: "Note changes",
      before: "",
      after: noteContent,
      sourceFieldId: "noteContent",
      contextLines: 2,
      emptyMessage: "No note content yet.",
      visibleForActionIds: ["save_note"],
    },
    {
      type: "textarea",
      id: "noteContent",
      label: "Final note content",
      value: noteContent,
      visibleForActionIds: ["save_note"],
      requiredForActionIds: ["save_note"],
    },
  ];
}

function prepareSearchReview(
  result: AgentToolResult,
): SearchReviewPrepared | null {
  if (!result.ok || !result.content || typeof result.content !== "object") {
    return null;
  }
  const content = result.content as Record<string, unknown>;
  const mode = readString(content.mode) as SearchLiteratureOnlineMode | undefined;
  const results = Array.isArray(content.results) ? content.results : [];
  if (!mode || results.length === 0) {
    return null;
  }

  if (mode === "metadata") {
    const rows: SearchReviewMetadataRow[] = [];
    const choices: SearchReviewMetadataChoice[] = [];
    for (const [index, entry] of results.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const rowId = `metadata-${index + 1}`;
      rows.push({
        key: rowId,
        label: readString(record.source) || `Result ${index + 1}`,
        before: readString((record.patch as Record<string, unknown> | undefined)?.url) ||
          bareDoi((record.patch as Record<string, unknown> | undefined)?.DOI),
        after: describeMetadataResult(record),
        multiline: true,
      });
      const choiceDetails = describeMetadataChoice(record);
      choices.push({
        rowId,
        title: choiceDetails.title,
        subtitle: choiceDetails.subtitle,
        badge: choiceDetails.badge,
        raw: record,
      });
    }
    if (!rows.length) return null;
    // Detect high confidence: translator source or DOI match confidence
    const firstRecord = results[0] as Record<string, unknown> | undefined;
    const source = readString(firstRecord?.source)?.toLowerCase();
    const matchConf = readString(firstRecord?.matchConfidence);
    const highConfidence = source === "zotero translator" || matchConf === "doi";
    return {
      kind: "metadata",
      mode,
      rows,
      choices,
      noteContent: "",
      highConfidence,
    };
  }

  const papers: SearchReviewPaper[] = [];
  for (const [index, entry] of results.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const title = readString(record.title);
    if (!title) continue;
    papers.push({
      rowId: `paper-${index + 1}`,
      title,
      subtitle: buildPaperSubtitle(record),
      body: readString(record.abstract),
      badges: buildPaperBadges(record),
      href: readString(record.openAccessUrl) || readString(record.sourceUrl),
      importIdentifier: buildImportIdentifier(record),
      raw: record,
    });
  }
  if (!papers.length) return null;
  return {
    kind: "paper_results",
    mode,
    source: readString(content.source),
    query: readString(content.query),
    papers,
  };
}

function getSearchActionButtons(kind: SearchReviewPrepared["kind"]) {
  if (kind === "metadata") {
    return [
      { id: "review_changes", label: "Review changes", style: "primary" as const },
      {
        id: "save_note",
        label: "Save metadata as note",
        style: "secondary" as const,
        executionMode: "edit" as const,
        submitLabel: "Save metadata as note",
      },
      { id: "cancel", label: "Cancel", style: "secondary" as const },
    ];
  }
  return [
    { id: "import", label: "Import selected", style: "primary" as const },
    {
      id: "save_note",
      label: "Save selected as note",
      style: "secondary" as const,
      executionMode: "edit" as const,
      submitLabel: "Save selected as note",
    },
    {
      id: "new_search",
      label: "Search again",
      style: "secondary" as const,
      executionMode: "edit" as const,
      submitLabel: "Confirm search",
      backLabel: "Get back",
    },
    { id: "cancel", label: "Cancel", style: "secondary" as const },
  ];
}

function normalizeSelectedRowIds(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function buildContinueFollowup(
  prepared: SearchReviewPrepared,
  selectedCount: number,
): AgentModelMessage {
  const summary =
    prepared.kind === "paper_results"
      ? `The user reviewed the online literature results and approved ${selectedCount} selected paper${
          selectedCount === 1 ? "" : "s"
        } for the next step. Use only the approved results in the attached tool output.`
      : "The user reviewed the external metadata results and approved them for the next step.";
  return {
    role: "user",
    content: summary,
  };
}

function filterSelectedPapers(
  prepared: Extract<SearchReviewPrepared, { kind: "paper_results" }>,
  selectedIds: string[],
): SearchReviewPaper[] {
  const selected = new Set(selectedIds);
  return prepared.papers.filter((paper) => selected.has(paper.rowId));
}

function normalizeSearchReviewArgs(args: unknown): SearchReviewArgs {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  const record = args as Record<string, unknown>;
  const paperContext = validateMetadataPaperContext(record.paperContext);
  return {
    mode: readString(record.mode) as SearchLiteratureOnlineMode | undefined,
    source: readString(record.source) as SearchLiteratureOnlineSource | undefined,
    limit: readPositiveInt(record.limit),
    libraryID: readPositiveInt(record.libraryID),
    itemId: readPositiveInt(record.itemId),
    paperContext,
    doi: readString(record.doi),
    title: readString(record.title),
    arxivId: readString(record.arxivId),
    query: readString(record.query),
  };
}

/**
 * Build before/after diff rows by comparing a metadata patch against
 * the current Zotero item's fields. Only includes rows where the value
 * would actually change (new value for empty field, or different value).
 */
function buildMetadataDiffRows(
  patch: EditableArticleMetadataPatch,
  context: AgentToolContext,
  args: SearchReviewArgs,
): SearchReviewMetadataRow[] {
  const rows: SearchReviewMetadataRow[] = [];
  // Try to get current item snapshot for before values
  let currentFields: Partial<Record<string, string>> = {};
  let currentCreatorsDisplay = "";
  const paperContext = args.paperContext || getReferencePaperContext(context);
  const itemId = args.itemId || paperContext?.itemId ||
    readPositiveInt(context.request.activeItemId);

  // We'll try to read from the context item if available
  if (context.item) {
    try {
      for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
        const val = context.item.getField?.(fieldName);
        if (typeof val === "string" && val.trim()) {
          currentFields[fieldName] = val.trim();
        }
      }
      const creators = context.item.getCreatorsJSON?.() || [];
      currentCreatorsDisplay = creators
        .map((c) => {
          const rec = c as unknown as Record<string, unknown>;
          return rec.name ? String(rec.name) : [rec.firstName, rec.lastName].filter(Boolean).join(" ");
        })
        .filter(Boolean)
        .join("; ");
    } catch (err) {
      ztoolkit.log("LLM: Review card metadata patch failed (best-effort)", err);
    }
  }

  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, fieldName)) continue;
    const newValue = patch[fieldName as EditableArticleMetadataField] ?? "";
    const before = currentFields[fieldName] ?? "";
    // Skip fields where value is identical
    if (before === newValue) continue;
    const label = METADATA_FIELD_DISPLAY_LABELS[fieldName] || fieldName;
    rows.push({
      key: fieldName,
      label,
      before,
      after: newValue,
      multiline: fieldName === "abstractNote",
    });
  }

  if (patch.creators?.length) {
    const after = formatCreatorsDisplay(patch.creators);
    if (currentCreatorsDisplay !== after) {
      rows.push({
        key: "creators",
        label: "Authors",
        before: currentCreatorsDisplay,
        after,
      });
    }
  }

  return rows;
}

function validateMetadataPaperContext(value: unknown): PaperContextRef | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? normalizeToolPaperContext(value as Record<string, unknown>) || undefined
    : undefined;
}

export function createSearchLiteratureReviewAction(
  result: AgentToolResult,
  context: AgentToolContext,
  args: unknown,
): AgentPendingAction | null {
  const prepared = prepareSearchReview(result);
  if (!prepared) return null;
  if (prepared.kind === "metadata") {
    const noteContent = buildMetadataNoteTemplate(context, prepared.rows);
    const normalizedArgs = normalizeSearchReviewArgs(args);
    const selectedChoice = resolveMetadataChoice(prepared, undefined, normalizedArgs, context);

    // High-confidence match (translator result or DOI match): skip source selection
    // and show a single "Review & Apply" card instead of the two-step flow.
    if (prepared.highConfidence && selectedChoice) {
      const metadata = buildMetadataUpdatePatch(selectedChoice.raw);
      if (metadata) {
        // Build before/after diff rows for the fields that would change
        const diffRows = buildMetadataDiffRows(metadata, context, normalizedArgs);
        return {
          toolName: "literature_search",
          mode: "review",
          title: "Review metadata changes",
          description:
            "These field changes will be applied to your Zotero item. Review the before/after values below.",
          confirmLabel: "Apply changes",
          cancelLabel: "Cancel",
          actions: [
            { id: "apply_direct", label: "Apply changes", style: "primary" as const },
            {
              id: "save_note",
              label: "Save metadata as note",
              style: "secondary" as const,
              executionMode: "edit" as const,
              submitLabel: "Save metadata as note",
            },
            { id: "cancel", label: "Cancel", style: "secondary" as const },
          ],
          defaultActionId: "apply_direct",
          cancelActionId: "cancel",
          fields: [
            {
              type: "review_table",
              id: "metadataDiff",
              label: "Field changes",
              rows: diffRows,
            },
            ...buildNoteDraftReviewFields(noteContent),
          ],
        };
      }
    }

    // Low-confidence: show the original source-selection card
    return {
      toolName: "literature_search",
      mode: "review",
      title: "Choose metadata source",
      description:
        "Choose the external source that best matches this paper. The next screen will show exact Zotero field changes before anything is applied.",
      confirmLabel: "Review changes",
      cancelLabel: "Cancel",
      actions: getSearchActionButtons(prepared.kind),
      defaultActionId: "review_changes",
      cancelActionId: "cancel",
      fields: [
        {
          type: "review_table",
          id: "metadataResults",
          label: "Metadata results",
          rows: prepared.rows,
        },
        {
          type: "select",
          id: "selectedMetadataResult",
          label: "Source to turn into Zotero changes",
          value: selectedChoice?.rowId || prepared.choices[0]?.rowId || "",
          options: buildMetadataChoiceOptions(prepared, normalizedArgs, context),
        },
        ...buildNoteDraftReviewFields(noteContent),
      ],
    };
  }

  const normalizedArgs = normalizeSearchReviewArgs(args);
  const noteContent = buildPaperNoteTemplate(context, prepared);
  return {
    toolName: "literature_search",
    mode: "review",
    title: "Review online literature results",
    description:
      "Select the papers you want to import or save to a note, or refine with a follow-up search.",
    confirmLabel: "Import selected",
    cancelLabel: "Cancel",
    actions: getSearchActionButtons(prepared.kind),
    defaultActionId: "import",
    cancelActionId: "cancel",
    fields: [
      {
        type: "paper_result_list",
        id: "selectedPaperIds",
        label: "Search results",
        rows: prepared.papers.map((paper) => ({
          id: paper.rowId,
          title: paper.title,
          subtitle: paper.subtitle,
          body: paper.body,
          badges: paper.badges,
          href: paper.href,
          importIdentifier: paper.importIdentifier,
          checked: true,
          year: typeof paper.raw.year === "number" ? paper.raw.year : undefined,
          citationCount: typeof paper.raw.citationCount === "number" ? paper.raw.citationCount : undefined,
        })),
        minSelectedByAction: [
          { actionId: "import", min: 1 },
          { actionId: "save_note", min: 1 },
        ],
        visibleForActionIds: ["import", "save_note"],
      },
      ...buildNoteDraftReviewFields(noteContent),
      {
        type: "text",
        id: "nextQuery",
        label: "Next search query",
        value: prepared.query || getReferencePaperTitle(context) || "",
        visibleForActionIds: ["new_search"],
        requiredForActionIds: ["new_search"],
      },
      {
        type: "select",
        id: "nextSource",
        label: "Search source",
        value: normalizedArgs.source || "openalex",
        options: [
          { id: "openalex", label: "OpenAlex" },
          { id: "arxiv", label: "arXiv" },
          { id: "europepmc", label: "Europe PMC" },
        ],
        visibleForActionIds: ["new_search"],
        requiredForActionIds: ["new_search"],
      },
      {
        type: "text",
        id: "nextLimit",
        label: "Result limit",
        value: String(normalizedArgs.limit || 10),
        visibleForActionIds: ["new_search"],
        requiredForActionIds: ["new_search"],
      },
    ],
  };
}

export function resolveSearchLiteratureReview(
  input: SearchReviewArgs,
  result: AgentToolResult,
  resolution: AgentConfirmationResolution,
  context: AgentToolContext,
): AgentToolReviewResolution {
  const prepared = prepareSearchReview(result);
  const normalizedArgs = input;
  const actionId = resolution.actionId || (resolution.approved ? "continue" : "cancel");
  const data =
    resolution.data && typeof resolution.data === "object" && !Array.isArray(resolution.data)
      ? (resolution.data as Record<string, unknown>)
      : {};

  if (!prepared || !resolution.approved || actionId === "cancel") {
    return {
      kind: "stop",
      finalText: "Stopped after review.",
    };
  }

  if (prepared.kind === "metadata") {
    if (actionId === "save_note") {
      const noteContent = normalizeNoteSourceText(
        readString(data.noteContent) || buildMetadataNoteTemplate(context, prepared.rows),
      );
      return {
        kind: "invoke_tool",
        call: {
          name: "note_write",
          arguments: {
            mode: "create",
            content: noteContent,
            target: "item",
          },
          inheritedApproval: {
            sourceToolName: "literature_search",
            sourceActionId: "save_metadata_note",
            sourceMode: "review",
          } satisfies AgentInheritedApproval,
        },
        terminalText: {
          onSuccess: "Saved the selected metadata to a note.",
          onDenied: "Metadata note save was cancelled.",
          onError: "Could not save the selected metadata to a note.",
        },
      };
    }
    if (actionId === "apply_direct") {
      // High-confidence path: user already reviewed the diff, apply directly
      const bestChoice = resolveMetadataChoice(prepared, undefined, normalizedArgs, context);
      const metadata = bestChoice ? buildMetadataUpdatePatch(bestChoice.raw) : null;
      const paperContext = normalizedArgs.paperContext || getReferencePaperContext(context);
      const itemId =
        normalizedArgs.itemId ||
        paperContext?.itemId ||
        readPositiveInt(context.request.activeItemId);
      if (!metadata || (!paperContext && !itemId)) {
        return {
          kind: "stop",
          finalText: "Could not prepare metadata changes from the selected result.",
        };
      }
      return {
        kind: "invoke_tool",
        call: {
          name: "library_update",
          arguments: {
            kind: "metadata",
            ...(paperContext ? { paperContext } : { itemId }),
            metadata,
          },
          inheritedApproval: {
            sourceToolName: "literature_search",
            sourceActionId: "apply_direct",
            sourceMode: "review",
          } satisfies AgentInheritedApproval,
        },
        terminalText: {
          onSuccess: "Applied the selected metadata to the paper.",
          onDenied: "Metadata update was cancelled.",
          onError: "Could not apply the selected metadata to the paper.",
        },
      };
    }
    if (actionId === "review_changes") {
      const selectedChoice = resolveMetadataChoice(
        prepared,
        readString(data.selectedMetadataResult),
        normalizedArgs,
        context,
      );
      const metadata = selectedChoice ? buildMetadataUpdatePatch(selectedChoice.raw) : null;
      const paperContext = normalizedArgs.paperContext || getReferencePaperContext(context);
      const itemId =
        normalizedArgs.itemId ||
        paperContext?.itemId ||
        readPositiveInt(context.request.activeItemId);
      if (!selectedChoice || !metadata || (!paperContext && !itemId)) {
        return {
          kind: "stop",
          finalText: "Could not prepare metadata changes from the selected result.",
        };
      }
      return {
        kind: "invoke_tool",
        call: {
          name: "library_update",
          arguments: {
            kind: "metadata",
            ...(paperContext ? { paperContext } : { itemId }),
            metadata,
          },
          inheritedApproval: {
            sourceToolName: "literature_search",
            sourceActionId: "review_changes",
            sourceMode: "review",
          } satisfies AgentInheritedApproval,
        },
        terminalText: {
          onSuccess: "Applied the selected metadata to the paper.",
          onDenied: "Metadata update was cancelled.",
          onError: "Could not apply the selected metadata to the paper.",
        },
      };
    }
    return {
      kind: "deliver",
      toolMessageContent: result.content,
      followupMessages: [buildContinueFollowup(prepared, prepared.rows.length)],
    };
  }

  const selectedIds = normalizeSelectedRowIds(data.selectedPaperIds);
  const selectedPapers = filterSelectedPapers(prepared, selectedIds);

  if (actionId === "import") {
    const identifiers = Array.from(
      new Set(
        selectedPapers
          .map((paper) => paper.importIdentifier)
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
    if (!identifiers.length) {
      return {
        kind: "stop",
        finalText: "No selected papers had an importable identifier.",
      };
    }
    return {
      kind: "invoke_tool",
      call: {
        name: "library_import",
        arguments: {
          kind: "identifiers",
          identifiers,
          libraryID: normalizedArgs.libraryID || context.request.libraryID,
        },
        inheritedApproval: {
          sourceToolName: "literature_search",
          sourceActionId: "import",
          sourceMode: "review",
        } satisfies AgentInheritedApproval,
      },
      terminalText: {
        onSuccess: "Imported the selected papers into Zotero.",
        onDenied: "Paper import was cancelled.",
        onError: "Could not import the selected papers into Zotero.",
      },
    };
  }

  if (actionId === "save_note") {
    const noteContent = normalizeNoteSourceText(
      readString(data.noteContent) || buildPaperNoteTemplate(context, prepared),
    );
    return {
      kind: "invoke_tool",
      call: {
        name: "note_write",
        arguments: {
          mode: "create",
          content: noteContent,
          target: "item",
        },
        inheritedApproval: {
          sourceToolName: "literature_search",
          sourceActionId: "save_paper_note",
          sourceMode: "review",
        } satisfies AgentInheritedApproval,
      },
      terminalText: {
        onSuccess: "Saved the selected papers to a note.",
        onDenied: "Paper note save was cancelled.",
        onError: "Could not save the selected papers to a note.",
      },
    };
  }

  if (actionId === "new_search") {
    return {
      kind: "invoke_tool",
      call: {
        name: "literature_search",
        arguments: {
          mode: "search",
          query:
            readString(data.nextQuery) ||
            prepared.query ||
            getReferencePaperTitle(context) ||
            context.request.userText,
          source:
            (readString(data.nextSource) as SearchLiteratureOnlineSource | undefined) ||
            normalizedArgs.source ||
            "openalex",
          limit: Math.min(
            25,
            Math.max(1, readPositiveInt(data.nextLimit) || normalizedArgs.limit || 10),
          ),
          libraryID: normalizedArgs.libraryID || context.request.libraryID,
        },
      },
    };
  }

  return {
    kind: "stop",
    finalText: "Stopped after review.",
  };
}
