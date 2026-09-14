import type { TrustedReadObservation } from "../plans/types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type { AgentRuntimeRequest, AgentToolArtifact } from "../types";
import type { DocumentCitationEvidence } from "./citationService";
import { finalizeDocument, persistFinalizedDocument } from "./finalizer";
import {
  loadLatestDocumentForRun,
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "./store";
import type {
  DocumentCoverageItem,
  PlanDocument,
  PlanDocumentAsset,
  PlanDocumentOutboxRecord,
  SubmitPlanDocumentInput,
} from "./types";
import {
  assertMaterialReady,
  materialDocumentId,
  resolveMaterialOutput,
} from "./workflowMaterial";
import { ToolInputRejection } from "../tools/execution/failure";
function directDocumentSpec(params: {
  request: AgentRuntimeRequest;
  title: string;
  hasCitations: boolean;
}) {
  const policy = params.request.documentOutcomePolicy;
  if (!policy?.required)
    throw new Error("This turn does not require a document");
  const researchGrounded = policy.integrityPolicy === "research_grounded";
  return {
    kind: policy.documentKind,
    title: params.title,
    requiredSections: researchGrounded ? ["Scope and limitations"] : [],
    requiresReferences: researchGrounded || params.hasCitations,
    requiresCoverageSection: researchGrounded,
    allowFigures: true,
    citationStyle: {
      styleId: "http://www.zotero.org/styles/apa",
      styleTitle: "APA",
      locale: params.request.classifiedIntent?.queryLanguage || "en-US",
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

export class DirectDocumentFinalizer {
  constructor(private readonly gateway: ZoteroGateway) {}

  async finalize(params: {
    request: AgentRuntimeRequest;
    runId: string;
    input: SubmitPlanDocumentInput;
    now?: number;
  }): Promise<{ document: PlanDocument; outbox: PlanDocumentOutboxRecord }> {
    const policy = params.request.documentOutcomePolicy;
    const material = resolveMaterialOutput(
      params.request,
      params.input.materialOutputId,
    );
    const stableDocumentId = material
      ? materialDocumentId(params.request, material.id)
      : undefined;
    if (
      !policy?.required ||
      (params.request.planContext?.phase === "executing" && !material)
    ) {
      throw new Error("Direct document finalization is not authorized");
    }
    const prior = stableDocumentId
      ? await loadPlanDocument(stableDocumentId)
      : await loadLatestDocumentForRun(params.runId);
    if (prior) {
      if (prior.conversationKey !== params.request.conversationKey)
        throw new Error(
          "The finalized material belongs to another conversation.",
        );
      const priorOutbox = await loadPlanDocumentOutbox(prior.documentId);
      if (!priorOutbox)
        throw new Error("The document exists without its outbox");
      return { document: prior, outbox: priorOutbox };
    }
    if (material) assertMaterialReady(params.request, material, this.gateway);
    const now = params.now ?? Date.now();
    const title = params.input.title.trim();
    const observations = params.request.documentReadObservations || [];
    const researchGrounded = policy.integrityPolicy === "research_grounded";
    if (
      researchGrounded &&
      !observations.some((entry) =>
        entry.capabilities.some((capability) =>
          ["abstract", "body", "figure", "quote"].includes(capability),
        ),
      )
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
      title,
      hasCitations: params.input.citations.length > 0,
    });
    const evidence = evidenceFromObservations(observations);
    const corpus = researchGrounded
      ? coverageFromObservations(observations)
      : params.input.citations.flatMap((cluster) => cluster.sources);
    const coverageItems = researchGrounded
      ? coverageFromObservations(observations)
      : [];
    const documentId = stableDocumentId || `${params.runId}:document:1`;
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
    await persistFinalizedDocument(finalized);
    return finalized;
  }
}
