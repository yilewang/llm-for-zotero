import type { ResearchCoverageStatus } from "./coverageTypes";
import type { SkillRoutingReceipt } from "../skills/routingTypes";

export const PLAN_DOCUMENT_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
export const PLAN_DOCUMENT_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const PLAN_DOCUMENT_ASSETS_MAX_BYTES = 100 * 1024 * 1024;
export const PLAN_DOCUMENT_GLOBAL_ASSETS_MAX_BYTES = 1024 * 1024 * 1024;

export type DocumentSpec = Readonly<{
  kind:
    | "research_brief"
    | "literature_review"
    | "comparison"
    | "report"
    | "guide"
    | "custom"
    // One note body of a batch. Host-only: the model never submits this kind,
    // it authors the bodies and the batch tool finalizes each one.
    | "note";
  title: string;
  requiredSections: readonly string[];
  requiresReferences: boolean;
  requiresCoverageSection: boolean;
  allowFigures: boolean;
  citationStyle: Readonly<{
    styleId: string;
    styleTitle: string;
    locale: string;
  }>;
}>;

export type DocumentIntegrityPolicy = "research_grounded" | "authored";

/** How a submitted document is validated: its kind and integrity policy. */
export type DocumentOutcomePolicy = Readonly<{
  documentKind: DocumentSpec["kind"];
  integrityPolicy: DocumentIntegrityPolicy;
}>;

/** A cited Zotero item. Stored sources without a kind are this kind. */
export type ZoteroCitationSource = Readonly<{
  kind?: undefined;
  libraryID: number;
  itemKey: string;
  evidenceRefs: readonly string[];
  locator?: Readonly<{
    kind: "pdf_page";
    attachmentItemKey: string;
    pageIndex: number;
    sourceFingerprint: string;
  }>;
}>;

/**
 * A cited outside paper: one literature_search or literature_read returned
 * in the run, by its paper source id. It has no Zotero evidence records
 * (`evidenceRefs` stays empty) and no page locator.
 */
export type OutsideCitationSource = Readonly<{
  kind: "outside";
  paperId: string;
  evidenceRefs: readonly string[];
}>;

export type PlanCitationSource = ZoteroCitationSource | OutsideCitationSource;

export function isOutsideCitationSource(
  source: Readonly<{ kind?: string }>,
): source is OutsideCitationSource {
  return source.kind === "outside";
}

/**
 * A cited source's identity: `paper:<paperId>` for an outside paper, else
 * `libraryID:itemKey`.
 */
export function citationSourceKey(
  source:
    | Pick<ZoteroCitationSource, "libraryID" | "itemKey">
    | Pick<OutsideCitationSource, "kind" | "paperId">,
): string {
  return "paperId" in source
    ? `paper:${source.paperId}`
    : `${source.libraryID}:${source.itemKey}`;
}

export type PlanCitationCluster = Readonly<{
  citationId: string;
  sources: readonly PlanCitationSource[];
}>;

export type FormattedCitationCluster = Readonly<{
  citationId: string;
  text: string;
  html: string;
  sources: readonly PlanCitationSource[];
}>;

/** A CSL-JSON name: family and given, or one name kept whole. */
export type CslName =
  | Readonly<{ family: string; given?: string; suffix?: string }>
  | Readonly<{ literal: string }>;

/** The CSL types an outside paper is formatted as. */
export const OUTSIDE_PAPER_CSL_TYPES = [
  "article-journal",
  "article",
  "paper-conference",
  "chapter",
  "book",
] as const;

export type OutsidePaperCslType = (typeof OUTSIDE_PAPER_CSL_TYPES)[number];

/**
 * The CSL-JSON item an outside paper is formatted from. Its id is `ext-<n>`:
 * never all digits (a Zotero item's CSL id is) and never containing "/".
 */
export type OutsidePaperCslItem = Readonly<{
  id: string;
  type: OutsidePaperCslType;
  title?: string;
  author?: readonly CslName[];
  issued?: Readonly<{ "date-parts": readonly (readonly number[])[] }>;
  DOI?: string;
  URL?: string;
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
}>;

/**
 * What a DOI lookup adds to an outside paper's CSL item. Its fields replace
 * the ones built from the run's record.
 */
export type OutsidePaperCslEnrichment = Partial<
  Pick<
    OutsidePaperCslItem,
    | "type"
    | "author"
    | "issued"
    | "container-title"
    | "volume"
    | "issue"
    | "page"
  >
>;

/**
 * A cited outside paper as the document keeps it: its identifiers and the
 * CSL-JSON it was formatted from. A snapshot, so the document renders, and
 * its papers can be imported, after the run that found them has ended.
 */
export type OutsidePaperSnapshot = Readonly<{
  paperId: string;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  csl: OutsidePaperCslItem;
}>;

/** A References entry for a cited Zotero item. */
export type ZoteroBibliographyEntry = Readonly<{
  libraryID: number;
  itemKey: string;
  text: string;
  html: string;
}>;

/**
 * A References entry for a cited outside paper. Its link comes from the
 * paper's identifiers in `outsidePapers`, not from the entry.
 */
export type OutsideBibliographyEntry = Readonly<{
  paperId: string;
  text: string;
  html: string;
}>;

export type BibliographyEntry =
  | ZoteroBibliographyEntry
  | OutsideBibliographyEntry;

export function isOutsideBibliographyEntry(
  entry: BibliographyEntry,
): entry is OutsideBibliographyEntry {
  return "paperId" in entry;
}

export type FormattedCitationBundle = Readonly<{
  clusters: readonly FormattedCitationCluster[];
  /** One list in citation-style order, Zotero and outside entries mixed. */
  bibliographyEntries: readonly BibliographyEntry[];
  style: Readonly<{ id: string; title: string }>;
  locale: string;
  /** The cited outside papers; absent when the document cites none. */
  outsidePapers?: readonly OutsidePaperSnapshot[];
}>;

/**
 * A document's text before its citations were formatted: the draft Markdown
 * with its `[[cite:ID]]` tokens, and the citation clusters as submitted. Kept
 * only for a document that cites an outside paper, so a later version can
 * cite the imported items without the model rewriting the text.
 */
export type DocumentCitationDraft = Readonly<{
  markdown: string;
  clusters: readonly PlanCitationCluster[];
}>;

/** The stored document a new version was made from. */
export type DocumentRevisionOf = Readonly<{
  documentId: string;
  documentVersion: number;
}>;

export type DocumentAssetProvenance =
  | Readonly<{
      origin: "extracted";
      libraryID: number;
      itemKey: string;
      attachmentItemKey: string;
      sourceFingerprint: string;
      pageIndex: number;
      extractionToolVersion: string;
    }>
  | Readonly<{
      origin: "generated";
      generator: string;
      generatorVersion: string;
      evidenceRefs: readonly string[];
    }>;

export type PlanDocumentAsset = Readonly<{
  assetId: string;
  contentHash: string;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
  caption: string;
  durablePath: string;
  provenance: DocumentAssetProvenance;
}>;

export type DocumentCoverageItem = Readonly<{
  libraryID: number;
  itemKey: string;
  title?: string;
  status: "included" | "excluded" | "unresolved" | "unreadable" | "missing";
  reason?: string;
  evidenceDepth: "metadata" | "abstract" | "body" | "none";
}>;

export type PlanDocumentValidation = Readonly<{
  integrityValidated: boolean;
  groundingReviewed: "passed" | "passed_with_limitations" | "not_run";
  quoteVerified: "verified" | "not_applicable";
  issues: readonly string[];
}>;

export type PlanVerifiedQuote = Readonly<{
  quoteId: string;
  text: string;
  libraryID: number;
  itemKey: string;
  attachmentItemKey: string;
  evidenceRefs: readonly string[];
  certificate: Readonly<{
    contextItemId: number;
    sourceFingerprint: string;
    pageIndex: number;
    sourceMatchText: string;
    sourceMatchKind: string;
    sourceMatchPageOccurrence: number;
  }>;
}>;

type DocumentArtifactFields = Readonly<{
  documentId: string;
  documentVersion: number;
  conversationKey: number;
  title: string;
  visibleMarkdown: string;
  visibleHtml: string;
  citationBundle: FormattedCitationBundle;
  verifiedQuotes: readonly PlanVerifiedQuote[];
  assets: readonly PlanDocumentAsset[];
  coverageStatus?: ResearchCoverageStatus;
  coverageItems: readonly DocumentCoverageItem[];
  validation: PlanDocumentValidation;
  contentHash: string;
  createdAt: number;
}>;

export type LegacyPlanDocument = DocumentArtifactFields &
  Readonly<{
    version: 1;
    planId: string;
    planRevision: number;
    executionId: string;
    parentTaskId: string;
    contractDigest: string;
  }>;

export type DocumentArtifactV2 = DocumentArtifactFields &
  Readonly<{
    version: 2;
    documentKind: DocumentSpec["kind"];
    integrityPolicy: DocumentIntegrityPolicy;
    origin:
      | Readonly<{
          kind: "planned";
          planId: string;
          planRevision: number;
          executionId: string;
          parentTaskId: string;
          contractDigest: string;
          scopeLineageDigest?: string;
        }>
      | Readonly<{
          kind: "direct";
          runId: string;
          sourceMessageTimestamp: number;
          routingReceipt?: SkillRoutingReceipt;
          /** @deprecated Compatibility with early DocumentArtifactV2 drafts. */
          skillRoutingReceiptHash?: string;
        }>;
    /** Present only when the document cites an outside paper. */
    citationDraft?: DocumentCitationDraft;
    /** Present only on a version made from an earlier document. */
    revisionOf?: DocumentRevisionOf;
  }>;

export type DocumentArtifact = LegacyPlanDocument | DocumentArtifactV2;

/** Compatibility name retained while Plan-specific callers migrate. */
export type PlanDocument = DocumentArtifact;

export function getPlannedDocumentOrigin(document: DocumentArtifact):
  | Readonly<{
      planId: string;
      planRevision: number;
      executionId: string;
      parentTaskId: string;
      contractDigest: string;
      scopeLineageDigest?: string;
    }>
  | undefined {
  return document.version === 1
    ? {
        planId: document.planId,
        planRevision: document.planRevision,
        executionId: document.executionId,
        parentTaskId: document.parentTaskId,
        contractDigest: document.contractDigest,
        scopeLineageDigest: undefined,
      }
    : document.origin.kind === "planned"
      ? document.origin
      : undefined;
}

export type DocumentNoteBinding = Readonly<{
  libraryID: number;
  itemKey: string;
  documentVersion?: number;
  contentHash?: string;
  nativeContentHash?: string;
  nativeContentHashVersion?: 1 | 2;
  parentItemId?: number;
  finalized?: boolean;
}>;
export type DocumentActionState = Readonly<{
  version: 1;
  documentId: string;
  savedNote?: DocumentNoteBinding;
  pendingNote?: DocumentNoteBinding;
  lastExportedAt?: number;
  lastExportedName?: string;
  updatedAt: number;
}>;

export type PlanDocumentOutboxRecord = Readonly<{
  version: 1;
  outboxId: string;
  documentId: string;
  conversationKey: number;
  messageTimestamp: number;
  visibleMarkdown: string;
  status: "pending" | "delivered" | "failed";
  attemptCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}>;

export type SubmitPlanDocumentInput = Readonly<{
  /** The document's shape. */
  documentKind?: DocumentSpec["kind"];
  /** Use research_grounded when claims depend on retrieved literature evidence. */
  integrityPolicy?: DocumentIntegrityPolicy;
  title: string;
  markdown: string;
  citations: readonly PlanCitationCluster[];
  quotes: readonly Readonly<{
    quoteId: string;
    text: string;
    libraryID: number;
    itemKey: string;
    attachmentItemKey: string;
    evidenceRefs: readonly string[];
  }>[];
  assets: readonly PlanDocumentAsset[];
  groundingReviewed: "passed" | "passed_with_limitations";
  groundingIssues: readonly string[];
}>;
