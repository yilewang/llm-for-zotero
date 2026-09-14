import type { ResearchCoverageStatus } from "../research/types";
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
    | "custom";
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

export type DocumentOutcomePolicy = Readonly<{
  required: boolean;
  documentKind: DocumentSpec["kind"];
  integrityPolicy: DocumentIntegrityPolicy;
  trigger:
    | "workflow_material"
    | "plan_deliverable"
    | "literature_review_skill"
    | "literature_review_intent"
    | "document_intent"
    | "none";
}>;

export type PlanCitationSource = Readonly<{
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

export type FormattedCitationBundle = Readonly<{
  clusters: readonly FormattedCitationCluster[];
  bibliographyEntries: readonly Readonly<{
    libraryID: number;
    itemKey: string;
    text: string;
    html: string;
  }>[];
  style: Readonly<{ id: string; title: string }>;
  locale: string;
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
  nativeContentHashVersion?: 1;
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
  materialOutputId?: string;
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
