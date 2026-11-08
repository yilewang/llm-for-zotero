import type { TrustedReadObservation } from "../context/readObservationTypes";
import {
  citableOutsidePapers,
  findOutsidePaperRecord,
  outsidePaperCitationRefusal,
  type OutsidePaperHolder,
} from "../context/outsidePaperRecords";
import { expandEvidenceRefs } from "../context/evidenceRefTokens";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { LiteratureSearchService } from "../services/literatureSearchService";
import type { AgentRuntimeRequest, AgentToolArtifact } from "../types";
import type {
  DocumentCitationCorpusItem,
  DocumentCitationEvidence,
} from "./citationService";
import { finalizeDocument, persistFinalizedDocument } from "./finalizer";
import {
  buildOutsidePaperSnapshots,
  type OutsidePaperMetadataLookup,
} from "./outsidePaperCitations";
import {
  directDocumentId,
  loadDocumentForRunByContentHash,
  loadLatestDocumentForRun,
  loadPlanDocumentOutbox,
  nextDirectDocumentSequence,
} from "./store";
import {
  citationSourceKey,
  isOutsideCitationSource,
  type DocumentArtifactV2,
  type DocumentCoverageItem,
  type DocumentOutcomePolicy,
  type PlanCitationCluster,
  type PlanCitationSource,
  type PlanDocument,
  type PlanDocumentAsset,
  type PlanDocumentOutboxRecord,
  type SubmitPlanDocumentInput,
  type ZoteroCitationSource,
} from "./types";
import { ToolInputRejection } from "../tools/execution/failure";
import { normalizeNoteSourceText } from "../../services/notes/noteRendering";

/**
 * The input with each cited outside paper under the id the run records it
 * by: a paper merged into another's record is cited by the record's id.
 */
function withCanonicalOutsidePaperIds(
  input: SubmitPlanDocumentInput,
  holder: OutsidePaperHolder,
): SubmitPlanDocumentInput {
  return {
    ...input,
    citations: input.citations.map((cluster) => ({
      ...cluster,
      sources: cluster.sources.map((source) => {
        if (!isOutsideCitationSource(source)) return source;
        const record = findOutsidePaperRecord(holder, source.paperId);
        return record && record.paperId !== source.paperId
          ? { ...source, paperId: record.paperId }
          : source;
      }),
    })),
  };
}

/** The already stored document, with the outbox record that published it. */
async function storedDocumentResult(document: PlanDocument): Promise<{
  document: PlanDocument;
  outbox: PlanDocumentOutboxRecord;
}> {
  const outbox = await loadPlanDocumentOutbox(document.documentId);
  if (!outbox) throw new Error("The document exists without its outbox");
  return { document, outbox };
}
export function directDocumentSpec(params: {
  request: AgentRuntimeRequest;
  policy: DocumentOutcomePolicy;
  title: string;
  hasCitations: boolean;
}) {
  const researchGrounded =
    params.policy.integrityPolicy === "research_grounded";
  return {
    kind: params.policy.documentKind,
    title: params.title,
    requiredSections: researchGrounded ? ["Scope and limitations"] : [],
    requiresReferences: researchGrounded || params.hasCitations,
    requiresCoverageSection: researchGrounded,
    allowFigures: true,
    citationStyle: {
      styleId: "http://www.zotero.org/styles/apa",
      styleTitle: "APA",
      locale:
        typeof params.request.metadata?.queryLanguage === "string"
          ? params.request.metadata.queryLanguage
          : "en-US",
    },
  } as const;
}

function evidenceFromObservations(
  observations: readonly TrustedReadObservation[],
): DocumentCitationEvidence[] {
  return observations.map((observation) => ({
    version: 2,
    evidenceRef: observation.observationId,
    observationId: observation.observationId,
    libraryID: observation.libraryID,
    itemKey: observation.itemKey,
    sourceKind: observation.capabilities.includes("body")
      ? "body"
      : observation.capabilities.includes("abstract")
        ? "abstract"
        : "metadata",
    locator:
      observation.attachmentItemKey &&
      observation.pageIndex !== undefined &&
      observation.sourceFingerprint
        ? {
            kind: "pdf_page",
            attachmentItemKey: observation.attachmentItemKey,
            pageIndex: observation.pageIndex,
            sourceFingerprint: observation.sourceFingerprint,
          }
        : observation.attachmentItemKey
          ? {
              kind: "attachment_text",
              attachmentItemKey: observation.attachmentItemKey,
              pageIndex: observation.pageIndex,
              sourceFingerprint: observation.sourceFingerprint,
            }
          : undefined,
  }));
}

function coverageFromObservations(
  observations: readonly TrustedReadObservation[],
): DocumentCoverageItem[] {
  const byItem = new Map<string, DocumentCoverageItem>();
  for (const observation of observations) {
    const key = `${observation.libraryID}:${observation.itemKey}`;
    const item =
      Zotero.Items.getByLibraryAndKey(
        observation.libraryID,
        observation.itemKey,
      ) || null;
    const depth = observation.capabilities.includes("body")
      ? "body"
      : observation.capabilities.includes("abstract")
        ? "abstract"
        : observation.capabilities.includes("metadata")
          ? "metadata"
          : "none";
    const prior = byItem.get(key);
    const rank = { none: 0, metadata: 1, abstract: 2, body: 3 } as const;
    if (prior && rank[prior.evidenceDepth] >= rank[depth]) continue;
    byItem.set(key, {
      libraryID: observation.libraryID,
      itemKey: observation.itemKey,
      title:
        String(
          item?.getField?.("title") || item?.getDisplayTitle?.() || "",
        ).trim() || undefined,
      status: "included",
      evidenceDepth: depth,
    });
  }
  return [...byItem.values()];
}

function normalizeAssetHash(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
}

function validateDirectAssetProvenance(params: {
  assets: readonly PlanDocumentAsset[];
  artifacts: readonly AgentToolArtifact[];
  observations: readonly TrustedReadObservation[];
  researchGrounded: boolean;
}): void {
  const observationIds = new Set(
    params.observations.map((entry) => entry.observationId),
  );
  for (const asset of params.assets) {
    const artifact = params.artifacts.find(
      (entry) =>
        entry.kind === "image" &&
        entry.storedPath === asset.durablePath &&
        entry.mimeType.toLowerCase() === asset.mimeType.toLowerCase() &&
        (!entry.contentHash ||
          normalizeAssetHash(entry.contentHash) ===
            normalizeAssetHash(asset.contentHash)),
    );
    if (!artifact) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} was not emitted by a successful host tool call`,
      );
    }
    if (asset.provenance.origin === "generated") {
      if (
        params.researchGrounded &&
        asset.provenance.evidenceRefs.some((ref) => !observationIds.has(ref))
      ) {
        throw new ToolInputRejection(
          `Generated asset ${asset.assetId} has an invalid evidence reference`,
        );
      }
      continue;
    }
    const provenance = asset.provenance;
    const sourceObservation = params.observations.some(
      (entry) =>
        entry.libraryID === provenance.libraryID &&
        entry.itemKey === provenance.itemKey &&
        entry.attachmentItemKey === provenance.attachmentItemKey &&
        entry.sourceFingerprint === provenance.sourceFingerprint &&
        entry.pageIndex === provenance.pageIndex &&
        entry.capabilities.includes("figure"),
    );
    if (!sourceObservation) {
      throw new ToolInputRejection(
        `Extracted asset ${asset.assetId} is not backed by a host-verified figure observation`,
      );
    }
  }
}

/**
 * The submission with every evidence ref it names as a full observation id:
 * tool results show refs in short form, and every check, and the stored
 * document, reads full ids.
 */
function withFullEvidenceRefs(
  input: SubmitPlanDocumentInput,
  observationIds: readonly string[],
): SubmitPlanDocumentInput {
  const expand = (refs: readonly string[]) =>
    expandEvidenceRefs(refs, observationIds);
  return {
    ...input,
    citations: input.citations.map((cluster) => ({
      ...cluster,
      sources: cluster.sources.map((source) => ({
        ...source,
        evidenceRefs: expand(source.evidenceRefs),
      })),
    })),
    quotes: input.quotes.map((quote) => ({
      ...quote,
      evidenceRefs: expand(quote.evidenceRefs),
    })),
    assets: input.assets.map((asset) =>
      asset.provenance.origin === "generated"
        ? {
            ...asset,
            provenance: {
              ...asset.provenance,
              evidenceRefs: expand(asset.provenance.evidenceRefs),
            },
          }
        : asset,
    ),
  };
}

export class DirectDocumentFinalizer {
  private readonly lookupOutsidePaperMetadata: OutsidePaperMetadataLookup;
  private readonly outsidePaperLookupTimeoutMs?: number;

  /**
   * `lookupOutsidePaperMetadata` finds a cited outside paper's CSL fields
   * (venue, volume, issue, pages, date, authors, type) by its DOI; by
   * default from Crossref, never by writing to the library.
   */
  constructor(
    private readonly gateway: ZoteroGateway,
    options: {
      lookupOutsidePaperMetadata?: OutsidePaperMetadataLookup;
      outsidePaperLookupTimeoutMs?: number;
    } = {},
  ) {
    this.lookupOutsidePaperMetadata =
      options.lookupOutsidePaperMetadata ||
      ((doi) =>
        new LiteratureSearchService(gateway).lookupCitationMetadataByDoi(doi));
    this.outsidePaperLookupTimeoutMs = options.outsidePaperLookupTimeoutMs;
  }

  async finalize(params: {
    request: AgentRuntimeRequest;
    runId: string;
    input: SubmitPlanDocumentInput;
    /**
     * The run can show the paper selection card, so the user is asked
     * whether to import outside papers before a document cites them. Where
     * no card can be shown, outside papers are cited without importing.
     */
    outsidePaperChoiceAvailable?: boolean;
    now?: number;
  }): Promise<{
    document: PlanDocument;
    outbox: PlanDocumentOutboxRecord;
    /** Format repairs the host made instead of rejecting. */
    repairs: string[];
  }> {
    const policy: DocumentOutcomePolicy = {
      documentKind: params.input.documentKind || "custom",
      integrityPolicy: params.input.integrityPolicy || "authored",
    };
    return this.publish({
      request: params.request,
      runId: params.runId,
      input: withFullEvidenceRefs(
        params.input,
        (params.request.documentReadObservations || []).map(
          (observation) => observation.observationId,
        ),
      ),
      policy,
      outsidePaperChoiceAvailable: params.outsidePaperChoiceAvailable,
      now: params.now,
    });
  }

  /**
   * Finalize one batch item's note body as its own durable document.
   *
   * A batch item is not the turn's deliverable, so it never inherits the
   * turn's document policy: a note written during a literature-review turn is
   * still a note, and holding it to that turn's grounding rules would reject
   * the whole batch. It is always authored material of kind `note`, titled
   * after the item it is written onto.
   */
  async finalizeNoteBody(params: {
    request: AgentRuntimeRequest;
    runId: string;
    title: string;
    markdown: string;
    now?: number;
  }): Promise<{
    document: PlanDocument;
    outbox: PlanDocumentOutboxRecord;
    /** Format repairs the host made instead of rejecting. */
    repairs: string[];
  }> {
    return this.publish({
      request: params.request,
      runId: params.runId,
      input: {
        title: params.title,
        // Exactly what `note_write` would store for the same body, so the
        // note carries the model's text and nothing the host invented.
        markdown: normalizeNoteSourceText(params.markdown),
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      policy: { documentKind: "note", integrityPolicy: "authored" },
      now: params.now,
    });
  }

  /**
   * Publish a new version of a stored document whose outside papers are now
   * Zotero items: the same title and text, each such paper cited as its
   * item, the papers left outside still cited outside, and one References
   * list formatted again. The stored document's text, figures, verified
   * quotes and Zotero citations were validated when it was published, so
   * they are carried over as they are. The stored document is unchanged.
   */
  async finalizeImportedCitations(params: {
    request: AgentRuntimeRequest;
    runId: string;
    document: DocumentArtifactV2;
    /** The Zotero item each outside paper now is, by paperId. */
    items: ReadonlyMap<string, { libraryID: number; itemKey: string }>;
    now?: number;
  }): Promise<{
    document: PlanDocument;
    outbox: PlanDocumentOutboxRecord;
    /** Format repairs the host made instead of rejecting. */
    repairs: string[];
  }> {
    const prior = params.document;
    const draft = prior.citationDraft;
    if (!draft)
      throw new ToolInputRejection(
        "The document keeps no citation draft, so a new version cannot cite the imported items.",
      );
    if (prior.conversationKey !== params.request.conversationKey)
      throw new Error(
        "The finalized material belongs to another conversation.",
      );
    const now = params.now ?? Date.now();
    // Each mapped outside paper becomes its item. A cluster that already
    // cites that item cites it once.
    const clusters: PlanCitationCluster[] = draft.clusters.map((cluster) => {
      const seen = new Set<string>();
      return {
        citationId: cluster.citationId,
        sources: cluster.sources.flatMap((source): PlanCitationSource[] => {
          const item = isOutsideCitationSource(source)
            ? params.items.get(source.paperId)
            : undefined;
          const cited: PlanCitationSource = item
            ? {
                libraryID: item.libraryID,
                itemKey: item.itemKey,
                evidenceRefs: [],
              }
            : source;
          const key = citationSourceKey(cited);
          if (seen.has(key)) return [];
          seen.add(key);
          return [cited];
        }),
      };
    });
    const sources = clusters.flatMap((cluster) => cluster.sources);
    const carriedSources = draft.clusters.flatMap((cluster) =>
      cluster.sources.filter(
        (source): source is ZoteroCitationSource =>
          !isOutsideCitationSource(source),
      ),
    );
    const spec = {
      ...directDocumentSpec({
        request: params.request,
        policy: {
          documentKind: prior.documentKind,
          integrityPolicy: prior.integrityPolicy,
        },
        title: prior.title,
        hasCitations: true,
      }),
      // The version is formatted as its document was.
      citationStyle: {
        styleId: prior.citationBundle.style.id,
        styleTitle: prior.citationBundle.style.title,
        locale: prior.citationBundle.locale,
      },
    };
    const documentId = directDocumentId(
      params.runId,
      await nextDirectDocumentSequence(params.runId),
    );
    const finalized = await finalizeDocument({
      gateway: this.gateway,
      input: {
        documentKind: prior.documentKind,
        integrityPolicy: prior.integrityPolicy,
        title: prior.title,
        markdown: draft.markdown,
        citations: clusters,
        // The draft's quotes are already resolved; their verified quotes
        // are carried over below.
        quotes: [],
        assets: prior.assets,
        groundingReviewed:
          prior.validation.groundingReviewed === "passed_with_limitations"
            ? "passed_with_limitations"
            : "passed",
        groundingIssues: prior.validation.issues,
      },
      now,
      context: {
        documentId,
        documentVersion: prior.documentVersion + 1,
        conversationKey: params.request.conversationKey,
        integrityPolicy: prior.integrityPolicy,
        origin: {
          kind: "direct",
          runId: params.runId,
          sourceMessageTimestamp:
            Number(params.request.metadata?.sourceMessageTimestamp) || now,
          routingReceipt: params.request.skillRoutingReceipt,
          skillRoutingReceiptHash:
            params.request.skillRoutingReceipt?.routerIdentityHash,
        },
        spec,
        evidence: [],
        corpus: sources.map((source) =>
          isOutsideCitationSource(source)
            ? { kind: "outside" as const, paperId: source.paperId }
            : { libraryID: source.libraryID, itemKey: source.itemKey },
        ),
        outsidePapers: (prior.citationBundle.outsidePapers || []).filter(
          (paper) => !params.items.has(paper.paperId),
        ),
        quoteCorpusKeys: new Set(),
        coverageItems: prior.coverageItems,
        coverageStatus: prior.coverageStatus,
        revisionOf: {
          documentId: prior.documentId,
          documentVersion: prior.documentVersion,
        },
        carriedOver: {
          verifiedQuotes: prior.verifiedQuotes,
          groundingReviewed: prior.validation.groundingReviewed,
          sources: carriedSources,
        },
        // The figures were attested when the stored document was published.
        validateAssetProvenance: () => undefined,
      },
    });
    // A retry of this call keeps the version the run already published.
    const duplicate = await loadDocumentForRunByContentHash({
      runId: params.runId,
      contentHash: finalized.document.contentHash,
      documentKind: spec.kind,
    });
    if (
      duplicate &&
      duplicate.conversationKey === params.request.conversationKey
    )
      return {
        ...(await storedDocumentResult(duplicate)),
        repairs: finalized.repairs,
      };
    await persistFinalizedDocument(finalized);
    return finalized;
  }

  private async publish(params: {
    request: AgentRuntimeRequest;
    runId: string;
    input: SubmitPlanDocumentInput;
    policy: DocumentOutcomePolicy;
    outsidePaperChoiceAvailable?: boolean;
    now?: number;
  }): Promise<{
    document: PlanDocument;
    outbox: PlanDocumentOutboxRecord;
    /** Format repairs the host made instead of rejecting. */
    repairs: string[];
  }> {
    const { policy } = params;
    params = {
      ...params,
      input: withCanonicalOutsidePaperIds(params.input, params.request),
    };
    const prior = await loadLatestDocumentForRun(params.runId);
    if (prior && prior.conversationKey !== params.request.conversationKey)
      throw new Error(
        "The finalized material belongs to another conversation.",
      );
    // A direct run may author several documents, and whether this submission
    // is a retry of the stored one is only known once its content hash is
    // computed below.
    const now = params.now ?? Date.now();
    const title = params.input.title.trim();
    const observations = params.request.documentReadObservations || [];
    const researchGrounded = policy.integrityPolicy === "research_grounded";
    // An outside paper is citable only when this run's literature_search or
    // literature_read returned it, and the user chose it when they chose.
    let citesOutsidePaper = false;
    for (const cluster of params.input.citations) {
      for (const source of cluster.sources) {
        if (!isOutsideCitationSource(source)) continue;
        citesOutsidePaper = true;
        const refusal = outsidePaperCitationRefusal(
          params.request,
          source.paperId,
        );
        if (refusal)
          throw new ToolInputRejection(
            `Citation ${cluster.citationId}: ${refusal}`,
          );
      }
    }
    // Where the card can be shown, the user chooses to import outside papers
    // or cite them without importing before a document cites one.
    if (
      citesOutsidePaper &&
      params.outsidePaperChoiceAvailable &&
      !params.request.outsidePaperSelection
    )
      throw new ToolInputRejection(
        "This document cites outside papers the user has not chosen to cite. Offer the user the choice first with a literature_search review search; cite only the papers they choose to cite.",
      );
    const outsidePapers = citableOutsidePapers(params.request);
    // An outside paper's abstract or text, as literature_read returned it,
    // is evidence as a Zotero abstract or body read is.
    if (
      researchGrounded &&
      !observations.some((entry) =>
        entry.capabilities.some((capability) =>
          ["abstract", "body", "figure", "quote"].includes(capability),
        ),
      ) &&
      !outsidePapers.some((paper) => paper.depth !== "metadata")
    ) {
      throw new ToolInputRejection(
        "A literature-review document requires host-verified abstract or body evidence",
      );
    }
    if (researchGrounded && !params.input.citations.length) {
      throw new ToolInputRejection(
        "A literature-review document requires grounded citations",
      );
    }
    const spec = directDocumentSpec({
      request: params.request,
      policy,
      title,
      hasCitations: params.input.citations.length > 0,
    });
    const evidence = evidenceFromObservations(observations);
    // Outside papers join the corpus from the run's record; coverage lists
    // Zotero items only.
    const corpus: DocumentCitationCorpusItem[] = researchGrounded
      ? [
          ...coverageFromObservations(observations),
          ...outsidePapers.map((paper) => ({
            kind: "outside" as const,
            paperId: paper.paperId,
          })),
        ]
      : params.input.citations.flatMap((cluster) => cluster.sources);
    const coverageItems = researchGrounded
      ? coverageFromObservations(observations)
      : [];
    // The cited outside papers, as the run recorded them, are formatted from
    // a snapshot the document keeps.
    const citedPaperIds = new Set(
      params.input.citations.flatMap((cluster) =>
        cluster.sources.flatMap((source) =>
          isOutsideCitationSource(source) ? [source.paperId] : [],
        ),
      ),
    );
    const outsidePaperSnapshots = citedPaperIds.size
      ? await buildOutsidePaperSnapshots({
          papers: outsidePapers.filter((paper) =>
            citedPaperIds.has(paper.paperId),
          ),
          lookup: this.lookupOutsidePaperMetadata,
          timeoutMs: this.outsidePaperLookupTimeoutMs,
          // One answer per DOI per run: a retry formats the same document.
          cache: (params.request.outsidePaperLookupCache ??= {}),
        })
      : [];
    const documentId = directDocumentId(
      params.runId,
      await nextDirectDocumentSequence(params.runId),
    );
    const finalized = await finalizeDocument({
      gateway: this.gateway,
      input: params.input,
      now,
      context: {
        documentId,
        documentVersion: 1,
        conversationKey: params.request.conversationKey,
        integrityPolicy: policy.integrityPolicy,
        origin: {
          kind: "direct",
          runId: params.runId,
          sourceMessageTimestamp:
            Number(params.request.metadata?.sourceMessageTimestamp) || now,
          routingReceipt: params.request.skillRoutingReceipt,
          skillRoutingReceiptHash:
            params.request.skillRoutingReceipt?.routerIdentityHash,
        },
        spec,
        evidence,
        corpus,
        outsidePapers: outsidePaperSnapshots,
        quoteCorpusKeys: new Set(
          observations.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
        ),
        coverageItems,
        coverageStatus: researchGrounded ? "partial" : undefined,
        validateAssetProvenance: () =>
          validateDirectAssetProvenance({
            assets: params.input.assets,
            artifacts: params.request.documentArtifactObservations || [],
            observations,
            researchGrounded,
          }),
      },
    });
    // The stored document is this submission only when its content is
    // identical: a retry keeps the identity the run already published.
    // Different content is a new document, never a silent substitution of
    // older content for the input the model just submitted. One run may
    // publish many documents — a note batch publishes one per item — so the
    // retry it is looking for is not always the newest one.
    const duplicate = await loadDocumentForRunByContentHash({
      runId: params.runId,
      contentHash: finalized.document.contentHash,
      documentKind: spec.kind,
    });
    if (
      duplicate &&
      duplicate.conversationKey === params.request.conversationKey
    )
      // Identical content means the same repairs were made again.
      return {
        ...(await storedDocumentResult(duplicate)),
        repairs: finalized.repairs,
      };
    await persistFinalizedDocument(finalized);
    return finalized;
  }
}
