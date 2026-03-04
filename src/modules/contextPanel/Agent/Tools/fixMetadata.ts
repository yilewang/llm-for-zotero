import { callLLM } from "../../../../utils/llmClient";
import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { pdfTextCache, pendingMetadataProposals } from "../../state";
import type { MetadataFieldProposal, MetadataAuthorEntry } from "../../state";
import { buildTruncatedFullPaperContext, ensurePDFTextCached } from "../../pdfContext";
import { validateSinglePaperToolCall } from "./shared";
import { sanitizeText } from "../../textUtils";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  ResolvedAgentToolTarget,
} from "./types";

/** Approx token budget for the paper text fed to the LLM. */
const FIX_METADATA_PAPER_CONTEXT_TOKENS = 6000;

/** Fields we will attempt to fill. Order matters — it controls display order. */
const METADATA_FIELDS: Array<{ fieldName: string; displayName: string }> = [
  { fieldName: "title",            displayName: "Title" },
  { fieldName: "abstractNote",     displayName: "Abstract" },
  { fieldName: "date",             displayName: "Year / Date" },
  { fieldName: "publicationTitle", displayName: "Journal / Publication" },
  { fieldName: "volume",           displayName: "Volume" },
  { fieldName: "issue",            displayName: "Issue" },
  { fieldName: "pages",            displayName: "Pages" },
  { fieldName: "DOI",              displayName: "DOI" },
  { fieldName: "url",              displayName: "URL" },
  { fieldName: "language",         displayName: "Language" },
];

export function validateFixMetadataCall(call: AgentToolCall): AgentToolCall | null {
  return validateSinglePaperToolCall("fix_metadata", call);
}

export async function executeFixMetadataCall(
  ctx: AgentToolExecutionContext,
  call: AgentToolCall,
  target: ResolvedAgentToolTarget,
): Promise<AgentToolExecutionResult> {
  const failed = (trace: string): AgentToolExecutionResult => ({
    name: "fix_metadata",
    targetLabel: target.targetLabel,
    ok: false,
    traceLines: [trace],
    groundingText: "",
    addedPaperContexts: [],
    estimatedTokens: 0,
    truncated: false,
  });

  if (!target.paperContext) {
    return failed(target.error || `Tool target was unavailable: ${target.targetLabel}.`);
  }

  // Resolve the PARENT Zotero item (the journal article / book chapter) —
  // this is what holds the editable metadata fields.  target.contextItem is
  // the PDF attachment (child item) which does NOT have those fields.
  const parentItemRaw = Zotero.Items.get(target.paperContext.itemId);
  const parentItem = (parentItemRaw as Zotero.Item | false) || null;
  if (!parentItem) {
    return failed(`Could not load Zotero item for ${target.targetLabel}.`);
  }

  // The attachment item is only needed for PDF text extraction.
  if (target.contextItem) {
    await ensurePDFTextCached(target.contextItem);
  }
  const pdfContext = target.contextItem
    ? pdfTextCache.get(target.contextItem.id)
    : undefined;
  const fullPaper = buildTruncatedFullPaperContext(
    target.paperContext,
    pdfContext,
    { maxTokens: FIX_METADATA_PAPER_CONTEXT_TOKENS },
  );

  // ── Read current metadata ──────────────────────────────────────────────────
  const currentFields: Record<string, string> = {};
  for (const { fieldName } of METADATA_FIELDS) {
    try {
      currentFields[fieldName] = String((parentItem as any).getField(fieldName) ?? "").trim();
    } catch {
      currentFields[fieldName] = "";
    }
  }

  // Current authors.
  let currentAuthorsStr = "";
  let hasNoAuthors = false;
  try {
    const creators: any[] = (parentItem as any).getCreators?.() ?? [];
    const authorTypeId: number = Zotero.CreatorTypes.getID("author") as number;
    const authors = creators.filter((c: any) => c.creatorTypeID === authorTypeId);
    currentAuthorsStr = authors
      .map((c: any) => [c.firstName, c.lastName].filter(Boolean).join(" "))
      .join("; ");
    hasNoAuthors = authors.length === 0;
  } catch {
    hasNoAuthors = true;
  }

  // Only call the LLM for fields that are genuinely empty.
  const emptyFields = METADATA_FIELDS.filter(
    ({ fieldName }) => !currentFields[fieldName],
  );

  if (emptyFields.length === 0 && !hasNoAuthors) {
    return {
      name: "fix_metadata",
      targetLabel: target.targetLabel,
      ok: true,
      traceLines: [`Metadata appears complete for ${target.targetLabel} — nothing to fix.`],
      groundingText: [
        "Agent Tool Result",
        "- Tool: fix_metadata",
        `- Target: ${target.targetLabel}`,
        "",
        "All metadata fields are already filled. Tell the user the metadata looks complete.",
      ].join("\n"),
      addedPaperContexts: [],
      estimatedTokens: 0,
      truncated: false,
    };
  }

  ctx.onStatus?.(`Extracting metadata for ${target.targetLabel}\u2026`);

  // ── Build extraction prompt ────────────────────────────────────────────────
  const fieldsToExtract = [
    ...emptyFields.map((f) => `"${f.fieldName}"`),
    ...(hasNoAuthors ? ['"authors"'] : []),
  ].join(", ");

  const schemaLines = [
    ...emptyFields.map(({ fieldName, displayName }) =>
      `  "${fieldName}": "<${displayName} from the paper, or null if not found>"`
    ),
    ...(hasNoAuthors
      ? ['  "authors": [{"firstName": "...", "lastName": "..."}, ...] or null']
      : []),
  ];

  const prompt = [
    "Extract the following missing bibliographic metadata fields from this academic paper.",
    `Fields needed: ${fieldsToExtract}`,
    "",
    "Return ONLY valid JSON with exactly those keys. Use null for any field not found in the paper.",
    "Be accurate — only extract values clearly stated in the paper.",
    "",
    "JSON format:",
    "{",
    ...schemaLines,
    "}",
    "",
    "Paper text:",
    fullPaper.text,
  ].join("\n");

  let rawResponse: string;
  try {
    rawResponse = await callLLM({
      prompt,
      model: ctx.model,
      apiBase: ctx.apiBase,
      apiKey: ctx.apiKey,
      maxTokens: 800,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failed(`Metadata extraction failed for ${target.targetLabel}: ${msg}`);
  }

  // ── Parse JSON ──────────────────────────────────────────────────────────────
  let extracted: Record<string, unknown> = {};
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      extracted = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    }
  } catch {
    extracted = {};
  }

  // ── Build field proposals ──────────────────────────────────────────────────
  const fieldProposals: MetadataFieldProposal[] = [];
  for (const { fieldName, displayName } of emptyFields) {
    const raw = extracted[fieldName];
    if (!raw || raw === null) continue;
    const proposed = sanitizeText(String(raw)).trim();
    if (proposed && proposed.toLowerCase() !== "null") {
      fieldProposals.push({
        fieldName,
        displayName,
        currentValue: currentFields[fieldName],
        proposedValue: proposed,
      });
    }
  }

  // ── Build author proposal ──────────────────────────────────────────────────
  let authorProposal:
    | { current: string; proposed: string; parsedAuthors: MetadataAuthorEntry[] }
    | undefined;

  if (hasNoAuthors) {
    const rawAuthors = extracted["authors"];
    if (Array.isArray(rawAuthors) && rawAuthors.length > 0) {
      const parsed: MetadataAuthorEntry[] = (rawAuthors as unknown[])
        .filter(
          (a): a is { firstName?: unknown; lastName?: unknown } =>
            a !== null && typeof a === "object",
        )
        .map((a) => ({
          firstName: sanitizeText(String(a.firstName ?? "")).trim(),
          lastName: sanitizeText(String(a.lastName ?? "")).trim(),
        }))
        .filter((a) => a.firstName || a.lastName);

      if (parsed.length > 0) {
        authorProposal = {
          current: currentAuthorsStr,
          proposed: parsed
            .map((a) => [a.firstName, a.lastName].filter(Boolean).join(" "))
            .join("; "),
          parsedAuthors: parsed,
        };
      }
    }
  }

  // ── Nothing found ──────────────────────────────────────────────────────────
  if (fieldProposals.length === 0 && !authorProposal) {
    return {
      name: "fix_metadata",
      targetLabel: target.targetLabel,
      ok: true,
      traceLines: [`Could not extract missing metadata from ${target.targetLabel}.`],
      groundingText: [
        "Agent Tool Result",
        "- Tool: fix_metadata",
        `- Target: ${target.targetLabel}`,
        "",
        "The missing metadata fields could not be found in the paper text.",
        "Tell the user that the LLM could not identify the missing fields in the paper content.",
      ].join("\n"),
      addedPaperContexts: [],
      estimatedTokens: 0,
      truncated: false,
    };
  }

  // ── Store proposals for the UI (keyed by PANEL item ID for refreshChat) ──
  // Using ctx.panelItemId so refreshChat's pendingMetadataProposals.get(item.id)
  // resolves correctly in both paper-chat and open-chat modes.
  pendingMetadataProposals.set(ctx.panelItemId, {
    itemId: target.paperContext.itemId,
    targetLabel: target.targetLabel,
    fields: fieldProposals,
    ...(authorProposal ? { authors: authorProposal } : {}),
  });

  const total = fieldProposals.length + (authorProposal ? 1 : 0);
  const names = [
    ...fieldProposals.map((f) => f.displayName),
    ...(authorProposal ? ["Authors"] : []),
  ].join(", ");

  const groundingText = [
    "Agent Tool Result",
    "- Tool: fix_metadata",
    `- Target: ${target.targetLabel}`,
    `- Proposed changes: ${total} field${total !== 1 ? "s" : ""} (${names})`,
    "",
    `A metadata review panel is now showing below the chat for ${target.targetLabel}.`,
    `Tell the user that ${total} metadata field${total !== 1 ? "s" : ""} could be filled in (${names}), and that a review panel has appeared where they can check each field and click Accept to apply the changes.`,
  ].join("\n");

  return {
    name: "fix_metadata",
    targetLabel: target.targetLabel,
    ok: true,
    traceLines: [
      `Found ${total} field${total !== 1 ? "s" : ""} to fill in for ${target.targetLabel}.`,
    ],
    groundingText,
    addedPaperContexts: [],
    estimatedTokens: estimateTextTokens(groundingText),
    truncated: false,
  };
}
