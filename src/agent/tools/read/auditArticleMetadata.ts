import type { PaperContextRef } from "../../../modules/contextPanel/types";
import type { PdfService } from "../../services/pdfService";
import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import type { AgentToolDefinition } from "../../types";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";
import { classifyRequest } from "../../model/requestClassifier";

type AuditArticleMetadataInput = {
  itemId?: number;
  paperContext?: PaperContextRef;
};


type MetadataFieldSuggestion = {
  field: EditableArticleMetadataField | "creators";
  before: string;
  after: string;
  reason: string;
  source: "library_match" | "front_matter";
  confidence: "high" | "medium";
};

type FrontMatterSignals = {
  doi?: string;
  creators: EditableArticleCreator[];
};

type LibraryMatchQuality = "exact_doi" | "exact_title_year" | "exact_title" | "weak";

type RankedLibraryReference = {
  candidate: EditableArticleMetadataSnapshot;
  score: number;
  quality: LibraryMatchQuality;
};

const CONSERVATIVE_LIBRARY_FIELDS: EditableArticleMetadataField[] = [
  "title",
  "publicationTitle",
  "journalAbbreviation",
  "proceedingsTitle",
  "date",
  "volume",
  "issue",
  "pages",
  "DOI",
];

const RISKY_LIBRARY_FIELDS: EditableArticleMetadataField[] = [
  "url",
  "ISSN",
  "ISBN",
  "publisher",
  "place",
  "language",
  "abstractNote",
  "extra",
];

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function normalizeComparableText(value: unknown): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompactText(value: unknown): string {
  return normalizeComparableText(value).replace(/\s+/g, "");
}

function extractComparableYear(value: unknown): string {
  const text = normalizeText(value);
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match?.[0] || "";
}

function normalizeCreatorName(creator: EditableArticleCreator): string {
  if (creator.fieldMode === 1 || creator.name) {
    return normalizeComparableText(creator.name);
  }
  return normalizeComparableText(
    [creator.firstName || "", creator.lastName || ""].filter(Boolean).join(" "),
  );
}

function creatorsDiffer(
  left: EditableArticleCreator[] | undefined,
  right: EditableArticleCreator[] | undefined,
): boolean {
  const leftNames = (left || []).map((entry) => normalizeCreatorName(entry)).filter(Boolean);
  const rightNames = (right || []).map((entry) => normalizeCreatorName(entry)).filter(Boolean);
  if (leftNames.length !== rightNames.length) return true;
  for (let index = 0; index < leftNames.length; index += 1) {
    if (leftNames[index] !== rightNames[index]) return true;
  }
  return false;
}

function countCreatorOverlap(
  left: EditableArticleCreator[] | undefined,
  right: EditableArticleCreator[] | undefined,
): number {
  const leftNames = new Set(
    (left || []).map((entry) => normalizeCreatorName(entry)).filter(Boolean),
  );
  const rightNames = new Set(
    (right || []).map((entry) => normalizeCreatorName(entry)).filter(Boolean),
  );
  let overlap = 0;
  for (const name of leftNames) {
    if (rightNames.has(name)) overlap += 1;
  }
  return overlap;
}

function candidateHasAllCurrentCreators(
  current: EditableArticleCreator[] | undefined,
  candidate: EditableArticleCreator[] | undefined,
): boolean {
  const currentNames = (current || [])
    .map((entry) => normalizeCreatorName(entry))
    .filter(Boolean);
  if (!currentNames.length) return true;
  const candidateNames = new Set(
    (candidate || []).map((entry) => normalizeCreatorName(entry)).filter(Boolean),
  );
  return currentNames.every((name) => candidateNames.has(name));
}

function formatCreators(creators: EditableArticleCreator[] | undefined): string {
  if (!Array.isArray(creators) || !creators.length) return "";
  return creators
    .map((creator) => {
      if (creator.fieldMode === 1 || creator.name) {
        return creator.name || "";
      }
      return [creator.firstName || "", creator.lastName || ""]
        .filter(Boolean)
        .join(" ")
        .trim();
    })
    .filter(Boolean)
    .join(", ");
}

function normalizeCreatorToken(value: string): string {
  return value
    .replace(/[\d*†‡§¶‖#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldIgnoreFrontMatterLine(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("abstract") ||
    lower.includes("introduction") ||
    lower.includes("doi") ||
    lower.includes("www.") ||
    lower.includes("http") ||
    lower.includes("@") ||
    lower.includes("university") ||
    lower.includes("department") ||
    lower.includes("journal") ||
    lower.includes("published by") ||
    lower.includes("supplemental")
  );
}

function looksLikeCreatorName(value: string): boolean {
  const normalized = normalizeCreatorToken(value);
  if (!normalized || shouldIgnoreFrontMatterLine(normalized)) return false;
  const tokens = normalized.split(/\s+/g).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  return tokens.every((token) => {
    if (/^(?:de|del|da|das|dos|di|du|la|le|van|von|der|den)$/iu.test(token)) {
      return true;
    }
    return /^[\p{Lu}][\p{L}'`.-]*$/u.test(token);
  });
}

function splitPotentialCreatorNames(value: string): string[] {
  return normalizeCreatorToken(value)
    .split(/(?:,|;|•|·|\band\b)/giu)
    .map((entry) => normalizeCreatorToken(entry))
    .filter(Boolean);
}

function parseFrontMatterCreators(text: string): EditableArticleCreator[] {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => normalizeCreatorToken(line))
    .filter(Boolean)
    .slice(0, 20);
  const names: string[] = [];
  let collectingSingleNameLines = false;
  for (const line of lines) {
    if (shouldIgnoreFrontMatterLine(line)) {
      if (names.length) break;
      continue;
    }
    const splitNames = splitPotentialCreatorNames(line).filter((entry) =>
      looksLikeCreatorName(entry),
    );
    if (splitNames.length >= 2) {
      names.push(...splitNames);
      collectingSingleNameLines = false;
      continue;
    }
    if (looksLikeCreatorName(line)) {
      names.push(line);
      collectingSingleNameLines = true;
      continue;
    }
    if (collectingSingleNameLines && names.length) {
      break;
    }
  }
  const unique = Array.from(new Set(names.map((entry) => entry.trim())));
  return unique.map((name) => {
    const parts = name.split(/\s+/g);
    if (parts.length >= 2) {
      return {
        creatorType: "author",
        firstName: parts.slice(0, -1).join(" "),
        lastName: parts[parts.length - 1],
        fieldMode: 0 as const,
      };
    }
    return {
      creatorType: "author",
      name,
      fieldMode: 1 as const,
    };
  });
}

function extractFrontMatterSignals(text: string): FrontMatterSignals {
  const doiMatch = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i);
  return {
    doi: doiMatch?.[0]?.trim(),
    creators: parseFrontMatterCreators(text),
  };
}

function datesAreCompatible(left: unknown, right: unknown): boolean {
  const leftNormalized = normalizeComparableText(left);
  const rightNormalized = normalizeComparableText(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized) return true;
  const leftYear = extractComparableYear(left);
  const rightYear = extractComparableYear(right);
  return Boolean(leftYear && rightYear && leftYear === rightYear);
}

function rankLibraryReferences(params: {
  current: EditableArticleMetadataSnapshot;
  candidates: EditableArticleMetadataSnapshot[];
}): RankedLibraryReference[] {
  const currentDoi = normalizeComparableText(params.current.fields.DOI);
  const currentTitle = normalizeComparableText(params.current.fields.title || params.current.title);
  const currentCompactTitle = normalizeCompactText(
    params.current.fields.title || params.current.title,
  );
  const currentYear = params.current.fields.date;

  return params.candidates
    .map((candidate) => {
      let score = 0;
      const doi = normalizeComparableText(candidate.fields.DOI);
      const title = normalizeComparableText(candidate.fields.title || candidate.title);
      const compactTitle = normalizeCompactText(candidate.fields.title || candidate.title);
      const exactDoi = Boolean(currentDoi && doi && currentDoi === doi);
      const exactTitle = Boolean(
        (currentTitle && title && currentTitle === title) ||
          (currentCompactTitle && compactTitle && currentCompactTitle === compactTitle),
      );
      const compatibleYear = datesAreCompatible(currentYear, candidate.fields.date);
      const overlap = countCreatorOverlap(params.current.creators, candidate.creators);
      const currentCreatorCount = Array.isArray(params.current.creators)
        ? params.current.creators.length
        : 0;
      const candidateCreatorCount = Array.isArray(candidate.creators)
        ? candidate.creators.length
        : 0;

      if (exactDoi) score += 200;
      if (exactTitle) score += 120;
      if (compatibleYear) score += 25;
      if (overlap > 0) score += overlap * 12;
      if (
        candidateCreatorCount > currentCreatorCount &&
        candidateHasAllCurrentCreators(params.current.creators, candidate.creators)
      ) {
        score += 8;
      }

      const quality: LibraryMatchQuality = exactDoi
        ? "exact_doi"
        : exactTitle && compatibleYear
          ? "exact_title_year"
          : exactTitle
            ? "exact_title"
            : "weak";
      return { candidate, score, quality };
    })
    .filter((entry) => entry.quality !== "weak")
    .sort((a, b) => b.score - a.score);
}

function collectHighTrustLibraryCandidates(params: {
  rankedReferences: RankedLibraryReference[];
  best: RankedLibraryReference | null;
}): RankedLibraryReference[] {
  const best = params.best;
  if (!best) return [];
  return params.rankedReferences.filter((entry) => {
    if (entry.quality !== best.quality) return false;
    return best.score - entry.score <= 20;
  });
}

function getConsensusLibraryFieldValue(
  field: EditableArticleMetadataField,
  references: RankedLibraryReference[],
): string {
  const values = references
    .map((entry) => normalizeText(entry.candidate.fields[field]))
    .filter(Boolean);
  if (!values.length) return "";
  const normalizedValues = Array.from(
    new Set(values.map((value) => normalizeComparableText(value)).filter(Boolean)),
  );
  return normalizedValues.length === 1 ? values[0] || "" : "";
}

function buildSuggestedPatch(params: {
  current: EditableArticleMetadataSnapshot;
  libraryReference: RankedLibraryReference | null;
  rankedReferences: RankedLibraryReference[];
  frontMatter: FrontMatterSignals;
}): {
  patch: EditableArticleMetadataPatch;
  suggestions: MetadataFieldSuggestion[];
} {
  const patch: EditableArticleMetadataPatch = {};
  const suggestions: MetadataFieldSuggestion[] = [];

  const trustedReferences = collectHighTrustLibraryCandidates({
    rankedReferences: params.rankedReferences,
    best: params.libraryReference,
  });

  const maybeSuggestField = (
    field: EditableArticleMetadataField,
    after: string,
    reason: string,
    source: MetadataFieldSuggestion["source"],
    confidence: MetadataFieldSuggestion["confidence"],
  ) => {
    const before = params.current.fields[field] || "";
    const normalizedBefore = normalizeComparableText(before);
    const normalizedAfter = normalizeComparableText(after);
    if (!normalizedAfter || normalizedBefore === normalizedAfter) return;
    const beforeMissing = !normalizedBefore;
    const afterLooksMoreSpecific =
      normalizeText(after).length > normalizeText(before).length;
    if (!beforeMissing && !afterLooksMoreSpecific) return;
    patch[field] = after;
    suggestions.push({
      field,
      before,
      after,
      reason,
      source,
      confidence,
    });
  };

  const reference = params.libraryReference?.candidate || null;
  const referenceQuality = params.libraryReference?.quality || "weak";
  if (reference) {
    for (const field of CONSERVATIVE_LIBRARY_FIELDS) {
      const referenceValue =
        referenceQuality === "exact_doi"
          ? getConsensusLibraryFieldValue(field, trustedReferences) ||
            reference.fields[field] ||
            ""
          : reference.fields[field] || "";
      const canUseField =
        referenceQuality === "exact_doi" ||
        referenceQuality === "exact_title_year";
      if (!canUseField) continue;
      maybeSuggestField(
        field,
        referenceValue,
        referenceQuality === "exact_doi"
          ? "Matching records with the same DOI support this normalized value."
          : "A very close library match supports this normalized value.",
        "library_match",
        referenceQuality === "exact_doi" ? "high" : "medium",
      );
    }
    if (
      Array.isArray(reference.creators) &&
      reference.creators.length &&
      creatorsDiffer(params.current.creators, reference.creators) &&
      candidateHasAllCurrentCreators(params.current.creators, reference.creators) &&
      reference.creators.length >
        (Array.isArray(params.current.creators) ? params.current.creators.length : 0)
    ) {
      const canUseCreators =
        referenceQuality === "exact_doi" ||
        referenceQuality === "exact_title_year";
      if (canUseCreators) {
        patch.creators = reference.creators;
        suggestions.push({
          field: "creators",
          before: formatCreators(params.current.creators),
          after: formatCreators(reference.creators),
          reason:
            referenceQuality === "exact_doi"
              ? "Matching records with the same DOI support a fuller creator list."
              : "A very close library match supports a fuller creator list.",
          source: "library_match",
          confidence: referenceQuality === "exact_doi" ? "high" : "medium",
        });
      }
    }

    if (referenceQuality === "exact_doi") {
      for (const field of RISKY_LIBRARY_FIELDS) {
        const currentValue = params.current.fields[field] || "";
        if (normalizeComparableText(currentValue)) continue;
        const consensusValue = getConsensusLibraryFieldValue(field, trustedReferences);
        if (!consensusValue) continue;
        maybeSuggestField(
          field,
          consensusValue,
          "Matching records with the same DOI agree on this missing field.",
          "library_match",
          "high",
        );
      }
    }
  }

  if (
    Array.isArray(params.frontMatter.creators) &&
    params.frontMatter.creators.length &&
    (!Array.isArray(patch.creators) ||
      patch.creators.length < params.frontMatter.creators.length) &&
    creatorsDiffer(params.current.creators, params.frontMatter.creators) &&
    params.frontMatter.creators.length >
      (Array.isArray(params.current.creators) ? params.current.creators.length : 0)
  ) {
    patch.creators = params.frontMatter.creators;
    const existingIndex = suggestions.findIndex(
      (entry) => entry.field === "creators",
    );
    const creatorSuggestion: MetadataFieldSuggestion = {
      field: "creators",
      before: formatCreators(params.current.creators),
      after: formatCreators(params.frontMatter.creators),
      reason: "The paper front matter shows a fuller creator list.",
      source: "front_matter",
      confidence: "high",
    };
    if (existingIndex >= 0) {
      suggestions[existingIndex] = creatorSuggestion;
    } else {
      suggestions.push(creatorSuggestion);
    }
  }

  if (
    params.frontMatter.doi &&
    !normalizeComparableText(params.current.fields.DOI)
  ) {
    patch.DOI = params.frontMatter.doi;
    suggestions.push({
      field: "DOI",
      before: params.current.fields.DOI || "",
      after: params.frontMatter.doi,
      reason: "The paper front matter exposes a DOI that is missing from the current metadata.",
      source: "front_matter",
      confidence: "high",
    });
  }

  return {
    patch,
    suggestions,
  };
}

function resolveAuditTarget(
  input: AuditArticleMetadataInput,
  context: Parameters<
    AgentToolDefinition<AuditArticleMetadataInput, unknown>["execute"]
  >[1],
  zoteroGateway: ZoteroGateway,
): Zotero.Item | null {
  return zoteroGateway.resolveMetadataItem({
    request: context.request,
    item: context.item,
    itemId: input.itemId,
    paperContext: input.paperContext,
  });
}

export function createAuditArticleMetadataTool(
  zoteroGateway: ZoteroGateway,
  pdfService: PdfService,
): AgentToolDefinition<AuditArticleMetadataInput, unknown> {
  return {
    spec: {
      name: "audit_article_metadata",
      description:
        "Audit the active article metadata systematically. Compares the current item against matching library records and paper front matter, then returns a suggested metadata patch with reasons, including creator-list issues.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: { type: "number" },
          paperContext: {
            type: "object",
            required: ["itemId", "contextItemId"],
            additionalProperties: true,
            properties: {
              itemId: { type: "number" },
              contextItemId: { type: "number" },
              title: { type: "string" },
            },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: (request) => classifyRequest(request).isMetadataAuditQuery,
      instruction: [
        "When the user asks to fix, clean up, standardize, or complete article metadata, do not default to a follow-up conversation.",
        "Treat metadata fixing as a full audit, not a spot edit. Review all supported metadata fields, especially creators/authors, title, venue, date, pages, DOI, URL, ISSN/ISBN, abstract, language, and extra.",
        "Start by inspecting the current article metadata. If any field is missing, incomplete, inconsistent, or likely non-standard, gather stronger evidence before editing.",
        "Use audit_article_metadata first. It compares the current item against matching library metadata and paper front matter, and it returns a suggestedPatch plus field-by-field reasons, including creator-list issues.",
        "Treat suggestedPatch from audit_article_metadata as the high-confidence subset. If it is non-empty, pass it directly into edit_article_metadata, either as patch or suggestedPatch, so the user can review the proposed change set.",
        "Only fall back to lower-level metadata tools such as search_library_items or read_paper_front_matter yourself when audit_article_metadata is inconclusive and you still need more evidence.",
        "Only ask a follow-up if the target article is ambiguous or you truly cannot infer a safe metadata correction.",
      ].join("\n"),
    },
    presentation: {
      label: "Audit Metadata",
      summaries: {
        onCall: "Auditing the article metadata field by field",
        onSuccess: ({ content }) => {
          const suggestions =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { suggestions?: unknown }).suggestions)
              ? (content as { suggestions: unknown[] }).suggestions
              : [];
          if (!suggestions.length) {
            return "The metadata already looks complete from the available evidence";
          }
          const includesCreators = suggestions.some(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              (entry as { field?: unknown }).field === "creators",
          );
          return includesCreators
            ? `Identified ${suggestions.length} metadata update${
                suggestions.length === 1 ? "" : "s"
              }, including the author list`
            : `Identified ${suggestions.length} metadata update${
                suggestions.length === 1 ? "" : "s"
              }`;
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const paperContext = validateObject<Record<string, unknown>>(args.paperContext)
        ? normalizeToolPaperContext(args.paperContext)
        : undefined;
      const itemId = normalizePositiveInt(args.itemId);
      return ok({
        itemId,
        paperContext: paperContext || undefined,
      });
    },
    execute: async (input, context) => {
      const item = resolveAuditTarget(input, context, zoteroGateway);
      if (!item) {
        throw new Error("No Zotero bibliographic item is active for metadata audit");
      }
      const current = zoteroGateway.getEditableArticleMetadata(item);
      if (!current) {
        throw new Error("No editable article metadata is available");
      }
      const libraryID =
        item.libraryID ||
        (Number.isFinite(context.request.libraryID)
          ? Math.floor(context.request.libraryID as number)
          : 0);
      const query = current.fields.DOI || current.fields.title || current.title;
      const searchResults = libraryID && query
        ? await zoteroGateway.searchLibraryItems({
            libraryID,
            query,
            excludeContextItemId: input.paperContext?.contextItemId || null,
            limit: 8,
          })
        : [];
      const candidates = searchResults
        .map((entry) => zoteroGateway.getEditableArticleMetadata(zoteroGateway.getItem(entry.itemId)))
        .filter(
          (entry): entry is EditableArticleMetadataSnapshot =>
            entry !== null && entry.itemId !== current.itemId,
        );
      const rankedReferences = rankLibraryReferences({
        current,
        candidates,
      });
      const libraryReference = rankedReferences[0] || null;

      let frontMatterText = "";
      let frontMatterSignals: FrontMatterSignals = { creators: [] };
      try {
        const paperContext =
          input.paperContext || pdfService.getPaperContextForItem(item);
        if (paperContext) {
          const excerpt = await pdfService.getFrontMatterExcerpt({
            paperContext,
          });
          frontMatterText = excerpt.text;
          frontMatterSignals = extractFrontMatterSignals(excerpt.text);
        }
      } catch (_error) {
        void _error;
      }

      const suggested = buildSuggestedPatch({
        current,
        libraryReference,
        rankedReferences,
        frontMatter: frontMatterSignals,
      });

      return {
        current,
        query,
        libraryReference,
        frontMatter: {
          text: frontMatterText,
          doi: frontMatterSignals.doi,
          creators: frontMatterSignals.creators,
        },
        suggestedPatch: suggested.patch,
        suggestions: suggested.suggestions,
      };
    },
  };
}
