import { OUTSIDE_PAPER_CSL_TYPES, type OutsidePaperCslType } from "./types";
import type {
  BibliographyEntry,
  CslName,
  DocumentCitationDraft,
  DocumentCoverageItem,
  DocumentArtifact,
  DocumentActionState,
  DocumentRevisionOf,
  FormattedCitationBundle,
  FormattedCitationCluster,
  OutsidePaperCslItem,
  OutsidePaperSnapshot,
  PlanCitationCluster,
  PlanCitationSource,
  PlanDocument,
  PlanDocumentAsset,
  PlanDocumentOutboxRecord,
  PlanDocumentValidation,
  PlanVerifiedQuote,
  ZoteroCitationSource,
} from "./types";
import type { SkillRoutingReceipt } from "../skills/routingTypes";

type Row = Record<string, unknown>;

function object(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Row;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function decodeRoutingReceipt(value: unknown): SkillRoutingReceipt | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "origin.routingReceipt");
  if (!Array.isArray(input.skills)) {
    throw new Error("origin.routingReceipt.skills must be an array");
  }
  const scopes = new Set([
    "none",
    "single-paper",
    "paper-set",
    "library-corpus",
    "note",
    "visual-input",
  ]);
  return {
    routerSchemaVersion: nonNegativeInteger(
      input.routerSchemaVersion,
      "origin.routingReceipt.routerSchemaVersion",
    ),
    routerIdentityHash: string(
      input.routerIdentityHash,
      "origin.routingReceipt.routerIdentityHash",
    ),
    skillManifestHash: string(
      input.skillManifestHash,
      "origin.routingReceipt.skillManifestHash",
    ),
    skills: input.skills.map((value, index) => {
      const label = `origin.routingReceipt.skills[${index}]`;
      const skill = object(value, label);
      if (skill.source !== "automatic" && skill.source !== "explicit") {
        throw new Error(`${label}.source is invalid`);
      }
      if (!scopes.has(String(skill.requestedScope))) {
        throw new Error(`${label}.requestedScope is invalid`);
      }
      let evidence: { text: string; start: number; end: number } | undefined;
      if (skill.evidence !== undefined) {
        const raw = object(skill.evidence, `${label}.evidence`);
        evidence = {
          text: string(raw.text, `${label}.evidence.text`),
          start: nonNegativeInteger(raw.start, `${label}.evidence.start`),
          end: nonNegativeInteger(raw.end, `${label}.evidence.end`),
        };
      }
      return {
        id: string(skill.id, `${label}.id`),
        source: skill.source,
        requestedScope:
          skill.requestedScope as SkillRoutingReceipt["skills"][number]["requestedScope"],
        evidence,
        version: nonNegativeInteger(skill.version, `${label}.version`),
        instructionHash: string(
          skill.instructionHash,
          `${label}.instructionHash`,
        ),
      };
    }),
  };
}

function decodeCitationSource(
  value: unknown,
  label: string,
): PlanCitationSource {
  const input = object(value, label);
  // A stored source without a kind is a Zotero item: every source before
  // outside papers could be cited.
  if (input.kind === "outside") {
    return {
      kind: "outside",
      paperId: string(input.paperId, `${label}.paperId`),
      evidenceRefs: strings(input.evidenceRefs ?? [], `${label}.evidenceRefs`),
    };
  }
  if (input.kind !== undefined) throw new Error(`${label}.kind is invalid`);
  let locator: ZoteroCitationSource["locator"];
  if (input.locator !== undefined) {
    const raw = object(input.locator, `${label}.locator`);
    if (raw.kind !== "pdf_page") {
      throw new Error(`${label}.locator.kind is invalid`);
    }
    locator = {
      kind: "pdf_page",
      attachmentItemKey: string(
        raw.attachmentItemKey,
        `${label}.locator.attachmentItemKey`,
      ),
      pageIndex: nonNegativeInteger(
        raw.pageIndex,
        `${label}.locator.pageIndex`,
      ),
      sourceFingerprint: string(
        raw.sourceFingerprint,
        `${label}.locator.sourceFingerprint`,
      ),
    };
  }
  return {
    libraryID: nonNegativeInteger(input.libraryID, `${label}.libraryID`),
    itemKey: string(input.itemKey, `${label}.itemKey`),
    evidenceRefs: strings(input.evidenceRefs, `${label}.evidenceRefs`),
    locator,
  };
}

/** An optional text field: absent stays absent, present must be text. */
function optionalString(
  input: Row,
  key: string,
  label: string,
): Record<string, string> {
  return input[key] === undefined
    ? {}
    : { [key]: string(input[key], `${label}.${key}`) };
}

function decodeCslName(value: unknown, label: string): CslName {
  const input = object(value, label);
  if (input.literal !== undefined)
    return { literal: string(input.literal, `${label}.literal`) };
  return {
    family: string(input.family, `${label}.family`),
    ...optionalString(input, "given", label),
    ...optionalString(input, "suffix", label),
  };
}

function decodeOutsidePaperCsl(
  value: unknown,
  label: string,
): OutsidePaperCslItem {
  const input = object(value, label);
  const id = string(input.id, `${label}.id`);
  if (/^\d+$/.test(id) || id.includes("/"))
    throw new Error(`${label}.id is invalid`);
  if (!OUTSIDE_PAPER_CSL_TYPES.some((type) => type === input.type))
    throw new Error(`${label}.type is invalid`);
  let issued: OutsidePaperCslItem["issued"];
  if (input.issued !== undefined) {
    const raw = object(input.issued, `${label}.issued`);
    const parts = raw["date-parts"];
    if (!Array.isArray(parts))
      throw new Error(`${label}.issued.date-parts must be an array`);
    issued = {
      "date-parts": parts.map((part, index) => {
        if (!Array.isArray(part))
          throw new Error(`${label}.issued.date-parts[${index}] is invalid`);
        return part.map((entry, partIndex) =>
          number(entry, `${label}.issued.date-parts[${index}][${partIndex}]`),
        );
      }),
    };
  }
  if (input.author !== undefined && !Array.isArray(input.author))
    throw new Error(`${label}.author must be an array`);
  return {
    id,
    type: input.type as OutsidePaperCslType,
    ...optionalString(input, "title", label),
    ...(Array.isArray(input.author)
      ? {
          author: input.author.map((name, index) =>
            decodeCslName(name, `${label}.author[${index}]`),
          ),
        }
      : {}),
    ...(issued ? { issued } : {}),
    ...optionalString(input, "DOI", label),
    ...optionalString(input, "URL", label),
    ...optionalString(input, "container-title", label),
    ...optionalString(input, "volume", label),
    ...optionalString(input, "issue", label),
    ...optionalString(input, "page", label),
  };
}

function decodeOutsidePaper(
  value: unknown,
  index: number,
): OutsidePaperSnapshot {
  const label = `citationBundle.outsidePapers[${index}]`;
  const input = object(value, label);
  return {
    paperId: string(input.paperId, `${label}.paperId`),
    ...optionalString(input, "doi", label),
    ...optionalString(input, "arxivId", label),
    ...optionalString(input, "pmid", label),
    ...optionalString(input, "pmcid", label),
    ...optionalString(input, "url", label),
    csl: decodeOutsidePaperCsl(input.csl, `${label}.csl`),
  };
}

function decodeCitationBundle(value: unknown): FormattedCitationBundle {
  const input = object(value, "citationBundle");
  if (
    !Array.isArray(input.clusters) ||
    !Array.isArray(input.bibliographyEntries)
  ) {
    throw new Error("citationBundle entries must be arrays");
  }
  const style = object(input.style, "citationBundle.style");
  const clusters: FormattedCitationCluster[] = input.clusters.map(
    (entry, index) => {
      const cluster = object(entry, `citationBundle.clusters[${index}]`);
      if (!Array.isArray(cluster.sources) || !cluster.sources.length) {
        throw new Error(`citationBundle.clusters[${index}].sources is invalid`);
      }
      return {
        citationId: string(
          cluster.citationId,
          `citationBundle.clusters[${index}].citationId`,
        ),
        text: string(cluster.text, `citationBundle.clusters[${index}].text`),
        html: string(cluster.html, `citationBundle.clusters[${index}].html`),
        sources: cluster.sources.map((source, sourceIndex) =>
          decodeCitationSource(
            source,
            `citationBundle.clusters[${index}].sources[${sourceIndex}]`,
          ),
        ),
      };
    },
  );
  if (input.outsidePapers !== undefined && !Array.isArray(input.outsidePapers))
    throw new Error("citationBundle.outsidePapers must be an array");
  const outsidePapers = Array.isArray(input.outsidePapers)
    ? input.outsidePapers.map(decodeOutsidePaper)
    : undefined;
  const bibliographyEntries = input.bibliographyEntries.map(
    (entry, index): BibliographyEntry => {
      const bibliography = object(
        entry,
        `citationBundle.bibliographyEntries[${index}]`,
      );
      // An entry with a paperId is an outside paper's; every entry stored
      // before outside papers is a Zotero item's.
      if (bibliography.paperId !== undefined) {
        return {
          paperId: string(
            bibliography.paperId,
            `citationBundle.bibliographyEntries[${index}].paperId`,
          ),
          text: string(
            bibliography.text,
            `citationBundle.bibliographyEntries[${index}].text`,
          ),
          html: string(
            bibliography.html,
            `citationBundle.bibliographyEntries[${index}].html`,
          ),
        };
      }
      return {
        libraryID: nonNegativeInteger(
          bibliography.libraryID,
          `citationBundle.bibliographyEntries[${index}].libraryID`,
        ),
        itemKey: string(
          bibliography.itemKey,
          `citationBundle.bibliographyEntries[${index}].itemKey`,
        ),
        text: string(
          bibliography.text,
          `citationBundle.bibliographyEntries[${index}].text`,
        ),
        html: string(
          bibliography.html,
          `citationBundle.bibliographyEntries[${index}].html`,
        ),
      };
    },
  );
  return {
    clusters,
    bibliographyEntries,
    style: {
      id: string(style.id, "citationBundle.style.id"),
      title: string(style.title, "citationBundle.style.title"),
    },
    locale: string(input.locale, "citationBundle.locale"),
    ...(outsidePapers ? { outsidePapers } : {}),
  };
}

function decodeCitationDraft(value: unknown): DocumentCitationDraft {
  const input = object(value, "citationDraft");
  if (!Array.isArray(input.clusters))
    throw new Error("citationDraft.clusters must be an array");
  if (typeof input.markdown !== "string")
    throw new Error("citationDraft.markdown is required");
  return {
    markdown: input.markdown,
    clusters: input.clusters.map((entry, index): PlanCitationCluster => {
      const label = `citationDraft.clusters[${index}]`;
      const cluster = object(entry, label);
      if (!Array.isArray(cluster.sources))
        throw new Error(`${label}.sources must be an array`);
      return {
        citationId: string(cluster.citationId, `${label}.citationId`),
        sources: cluster.sources.map((source, sourceIndex) =>
          decodeCitationSource(source, `${label}.sources[${sourceIndex}]`),
        ),
      };
    }),
  };
}

function decodeRevisionOf(value: unknown): DocumentRevisionOf {
  const input = object(value, "revisionOf");
  return {
    documentId: string(input.documentId, "revisionOf.documentId"),
    documentVersion: nonNegativeInteger(
      input.documentVersion,
      "revisionOf.documentVersion",
    ),
  };
}

function decodeVerifiedQuote(value: unknown, index: number): PlanVerifiedQuote {
  const label = `verifiedQuotes[${index}]`;
  const input = object(value, label);
  const certificate = object(input.certificate, `${label}.certificate`);
  return {
    quoteId: string(input.quoteId, `${label}.quoteId`),
    text: string(input.text, `${label}.text`),
    libraryID: nonNegativeInteger(input.libraryID, `${label}.libraryID`),
    itemKey: string(input.itemKey, `${label}.itemKey`),
    attachmentItemKey: string(
      input.attachmentItemKey,
      `${label}.attachmentItemKey`,
    ),
    evidenceRefs: strings(input.evidenceRefs, `${label}.evidenceRefs`),
    certificate: {
      contextItemId: nonNegativeInteger(
        certificate.contextItemId,
        `${label}.certificate.contextItemId`,
      ),
      sourceFingerprint: string(
        certificate.sourceFingerprint,
        `${label}.certificate.sourceFingerprint`,
      ),
      pageIndex: nonNegativeInteger(
        certificate.pageIndex,
        `${label}.certificate.pageIndex`,
      ),
      sourceMatchText: string(
        certificate.sourceMatchText,
        `${label}.certificate.sourceMatchText`,
      ),
      sourceMatchKind: string(
        certificate.sourceMatchKind,
        `${label}.certificate.sourceMatchKind`,
      ),
      sourceMatchPageOccurrence: nonNegativeInteger(
        certificate.sourceMatchPageOccurrence,
        `${label}.certificate.sourceMatchPageOccurrence`,
      ),
    },
  };
}

function decodeAsset(value: unknown, index: number): PlanDocumentAsset {
  const label = `assets[${index}]`;
  const input = object(value, label);
  const rawProvenance = object(input.provenance, `${label}.provenance`);
  const provenance: PlanDocumentAsset["provenance"] =
    rawProvenance.origin === "extracted"
      ? {
          origin: "extracted",
          libraryID: nonNegativeInteger(
            rawProvenance.libraryID,
            `${label}.provenance.libraryID`,
          ),
          itemKey: string(rawProvenance.itemKey, `${label}.provenance.itemKey`),
          attachmentItemKey: string(
            rawProvenance.attachmentItemKey,
            `${label}.provenance.attachmentItemKey`,
          ),
          sourceFingerprint: string(
            rawProvenance.sourceFingerprint,
            `${label}.provenance.sourceFingerprint`,
          ),
          pageIndex: nonNegativeInteger(
            rawProvenance.pageIndex,
            `${label}.provenance.pageIndex`,
          ),
          extractionToolVersion: string(
            rawProvenance.extractionToolVersion,
            `${label}.provenance.extractionToolVersion`,
          ),
        }
      : rawProvenance.origin === "generated"
        ? {
            origin: "generated",
            generator: string(
              rawProvenance.generator,
              `${label}.provenance.generator`,
            ),
            generatorVersion: string(
              rawProvenance.generatorVersion,
              `${label}.provenance.generatorVersion`,
            ),
            evidenceRefs: strings(
              rawProvenance.evidenceRefs,
              `${label}.provenance.evidenceRefs`,
            ),
          }
        : (() => {
            throw new Error(`${label}.provenance.origin is invalid`);
          })();
  return {
    assetId: string(input.assetId, `${label}.assetId`),
    contentHash: string(input.contentHash, `${label}.contentHash`),
    mimeType: string(input.mimeType, `${label}.mimeType`),
    byteLength: nonNegativeInteger(input.byteLength, `${label}.byteLength`),
    width:
      input.width === undefined
        ? undefined
        : nonNegativeInteger(input.width, `${label}.width`),
    height:
      input.height === undefined
        ? undefined
        : nonNegativeInteger(input.height, `${label}.height`),
    caption: string(input.caption, `${label}.caption`),
    durablePath: string(input.durablePath, `${label}.durablePath`),
    provenance,
  };
}

export function decodeDocumentCoverageItem(
  value: unknown,
): DocumentCoverageItem {
  const input = object(value, "document coverage item");
  if (
    !["included", "excluded", "unresolved", "unreadable", "missing"].includes(
      String(input.status),
    )
  ) {
    throw new Error("document coverage status is invalid");
  }
  if (
    !["metadata", "abstract", "body", "none"].includes(
      String(input.evidenceDepth),
    )
  ) {
    throw new Error("document coverage evidence depth is invalid");
  }
  return {
    libraryID: nonNegativeInteger(input.libraryID, "coverage.libraryID"),
    itemKey: string(input.itemKey, "coverage.itemKey"),
    title: typeof input.title === "string" ? input.title : undefined,
    status: input.status as DocumentCoverageItem["status"],
    reason: typeof input.reason === "string" ? input.reason : undefined,
    evidenceDepth: input.evidenceDepth as DocumentCoverageItem["evidenceDepth"],
  };
}

function decodeValidation(value: unknown): PlanDocumentValidation {
  const input = object(value, "validation");
  if (
    !["passed", "passed_with_limitations", "not_run"].includes(
      String(input.groundingReviewed),
    ) ||
    !["verified", "not_applicable"].includes(String(input.quoteVerified))
  ) {
    throw new Error("plan document validation state is invalid");
  }
  return {
    integrityValidated: input.integrityValidated === true,
    groundingReviewed:
      input.groundingReviewed as PlanDocumentValidation["groundingReviewed"],
    quoteVerified:
      input.quoteVerified as PlanDocumentValidation["quoteVerified"],
    issues: strings(input.issues, "validation.issues"),
  };
}

export function decodePlanDocument(value: unknown): PlanDocument {
  const input = object(value, "plan document");
  if (input.version !== 1 && input.version !== 2) {
    throw new Error("Unsupported document version");
  }
  if (
    !Array.isArray(input.assets) ||
    !Array.isArray(input.coverageItems) ||
    (input.verifiedQuotes !== undefined && !Array.isArray(input.verifiedQuotes))
  ) {
    throw new Error(
      "Plan document assets, quotes, and coverage must be arrays",
    );
  }
  if (
    input.coverageStatus !== undefined &&
    !["complete", "complete_with_limitations", "partial", "failed"].includes(
      String(input.coverageStatus),
    )
  ) {
    throw new Error("Document coverage status is invalid");
  }
  const common = {
    documentId: string(input.documentId, "documentId"),
    documentVersion: number(input.documentVersion, "documentVersion"),
    conversationKey: number(input.conversationKey, "conversationKey"),
    title: string(input.title, "title"),
    visibleMarkdown: string(input.visibleMarkdown, "visibleMarkdown"),
    visibleHtml: string(input.visibleHtml, "visibleHtml"),
    citationBundle: decodeCitationBundle(input.citationBundle),
    verifiedQuotes: Array.isArray(input.verifiedQuotes)
      ? input.verifiedQuotes.map(decodeVerifiedQuote)
      : [],
    assets: input.assets.map(decodeAsset),
    coverageStatus: input.coverageStatus as DocumentArtifact["coverageStatus"],
    coverageItems: input.coverageItems.map(decodeDocumentCoverageItem),
    validation: decodeValidation(input.validation),
    contentHash: string(input.contentHash, "contentHash"),
    createdAt: number(input.createdAt, "createdAt"),
  };
  if (input.version === 2) {
    const origin = object(input.origin, "origin");
    const documentKinds = [
      "research_brief",
      "literature_review",
      "comparison",
      "report",
      "guide",
      "custom",
      "note",
    ];
    if (!documentKinds.includes(String(input.documentKind))) {
      throw new Error("documentKind is invalid");
    }
    if (
      input.integrityPolicy !== "research_grounded" &&
      input.integrityPolicy !== "authored"
    ) {
      throw new Error("integrityPolicy is invalid");
    }
    const decodedOrigin =
      origin.kind === "planned"
        ? {
            kind: "planned" as const,
            planId: string(origin.planId, "origin.planId"),
            planRevision: number(origin.planRevision, "origin.planRevision"),
            executionId: string(origin.executionId, "origin.executionId"),
            parentTaskId: string(origin.parentTaskId, "origin.parentTaskId"),
            contractDigest: string(
              origin.contractDigest,
              "origin.contractDigest",
            ),
            scopeLineageDigest:
              origin.scopeLineageDigest === undefined
                ? undefined
                : string(
                    origin.scopeLineageDigest,
                    "origin.scopeLineageDigest",
                  ),
          }
        : origin.kind === "direct"
          ? {
              kind: "direct" as const,
              runId: string(origin.runId, "origin.runId"),
              sourceMessageTimestamp: nonNegativeInteger(
                origin.sourceMessageTimestamp,
                "origin.sourceMessageTimestamp",
              ),
              routingReceipt: decodeRoutingReceipt(origin.routingReceipt),
              skillRoutingReceiptHash:
                typeof origin.skillRoutingReceiptHash === "string"
                  ? origin.skillRoutingReceiptHash
                  : undefined,
            }
          : null;
    if (!decodedOrigin) throw new Error("document origin is invalid");
    return {
      version: 2,
      documentKind: input.documentKind as Extract<
        DocumentArtifact,
        { version: 2 }
      >["documentKind"],
      integrityPolicy: input.integrityPolicy,
      origin: decodedOrigin,
      ...common,
      ...(input.citationDraft === undefined
        ? {}
        : { citationDraft: decodeCitationDraft(input.citationDraft) }),
      ...(input.revisionOf === undefined
        ? {}
        : { revisionOf: decodeRevisionOf(input.revisionOf) }),
    };
  }
  return {
    version: 1,
    planId: string(input.planId, "planId"),
    planRevision: number(input.planRevision, "planRevision"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    contractDigest: string(input.contractDigest, "contractDigest"),
    ...common,
  };
}

function decodeDocumentNoteBinding(
  value: unknown,
): DocumentActionState["savedNote"] {
  if (value === undefined) return undefined;
  const note = object(value, "document note binding");
  return {
    libraryID: number(note.libraryID, "note.libraryID"),
    itemKey: string(note.itemKey, "note.itemKey"),
    documentVersion:
      note.documentVersion === undefined
        ? undefined
        : nonNegativeInteger(note.documentVersion, "note.documentVersion"),
    contentHash:
      note.contentHash === undefined
        ? undefined
        : string(note.contentHash, "note.contentHash"),
    nativeContentHashVersion:
      note.nativeContentHashVersion === 1 || note.nativeContentHashVersion === 2
        ? note.nativeContentHashVersion
        : undefined,
    nativeContentHash:
      note.nativeContentHash === undefined
        ? undefined
        : string(note.nativeContentHash, "note.nativeContentHash"),
    parentItemId:
      note.parentItemId === undefined
        ? undefined
        : number(note.parentItemId, "note.parentItemId"),
    ...(note.finalized === undefined
      ? {}
      : { finalized: note.finalized === true }),
  };
}
export function decodeDocumentActionState(value: unknown): DocumentActionState {
  const input = object(value, "document action state");
  if (input.version !== 1) throw new Error("Unsupported action state version");
  return {
    version: 1,
    documentId: string(input.documentId, "documentId"),
    savedNote: decodeDocumentNoteBinding(input.savedNote),
    pendingNote: decodeDocumentNoteBinding(input.pendingNote),
    lastExportedAt:
      input.lastExportedAt === undefined
        ? undefined
        : number(input.lastExportedAt, "lastExportedAt"),
    lastExportedName:
      typeof input.lastExportedName === "string"
        ? input.lastExportedName
        : undefined,
    updatedAt: number(input.updatedAt, "updatedAt"),
  };
}

export function decodePlanDocumentOutbox(
  value: unknown,
): PlanDocumentOutboxRecord {
  const input = object(value, "plan document outbox");
  if (input.version !== 1) throw new Error("Unsupported outbox version");
  if (
    input.status !== "pending" &&
    input.status !== "delivered" &&
    input.status !== "failed"
  ) {
    throw new Error("Invalid document outbox status");
  }
  return {
    version: 1,
    outboxId: string(input.outboxId, "outboxId"),
    documentId: string(input.documentId, "documentId"),
    conversationKey: number(input.conversationKey, "conversationKey"),
    messageTimestamp: number(input.messageTimestamp, "messageTimestamp"),
    visibleMarkdown: string(input.visibleMarkdown, "visibleMarkdown"),
    status: input.status,
    attemptCount: number(input.attemptCount, "attemptCount"),
    lastError:
      typeof input.lastError === "string" ? input.lastError : undefined,
    createdAt: number(input.createdAt, "createdAt"),
    updatedAt: number(input.updatedAt, "updatedAt"),
    deliveredAt:
      input.deliveredAt === undefined
        ? undefined
        : number(input.deliveredAt, "deliveredAt"),
  };
}
