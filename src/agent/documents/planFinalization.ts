import {
  listTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../plans/store";
import { assertTaskCompletionEvidence } from "../plans/taskState";
import type { PlanExecutionLedger, TaskEvidence } from "../plans/types";
import { getResearchItemFingerprints } from "../research/scopeSnapshot";
import { computeResearchQualityReport } from "../research/rubric";
import {
  listPaperFindings,
  listResearchCorpusItems,
  listResearchEdges,
  listResearchEvidence,
  listResearchOpenQuestions,
  listScopeSnapshotItems,
  listThemeFindings,
  loadResearchJobForExecution,
  saveResearchJob,
} from "../research/store";
import type {
  ResearchCorpusItem,
  ResearchEvidenceRecord,
} from "../research/types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { finalizeDocument, persistFinalizedDocument } from "./finalizer";
import {
  loadLatestPlanDocumentForExecution,
  loadPlanDocumentOutbox,
  nextPlanDocumentVersion,
} from "./store";
import type {
  DocumentCoverageItem,
  PlanDocument,
  PlanDocumentOutboxRecord,
  SubmitPlanDocumentInput,
} from "./types";
import { getPlannedDocumentOrigin } from "./types";
import { ToolInputRejection } from "../tools/execution/failure";
function coverageItem(
  item: ResearchCorpusItem,
  evidence: readonly ResearchEvidenceRecord[],
): DocumentCoverageItem {
  const liveItem = Zotero.Items.getByLibraryAndKey(
    item.libraryID,
    item.itemKey,
  );
  const title = liveItem
    ? String(liveItem.getField?.("title") || "").trim() || undefined
    : undefined;
  const status =
    item.screeningStatus === "included"
      ? "included"
      : item.screeningStatus === "excluded"
        ? "excluded"
        : item.screeningStatus === "unreadable"
          ? "unreadable"
          : item.screeningStatus === "missing"
            ? "missing"
            : "unresolved";
  return {
    libraryID: item.libraryID,
    itemKey: item.itemKey,
    title,
    status,
    reason: item.decisionReason,
    evidenceDepth: (() => {
      const kinds = evidence
        .filter(
          (entry) =>
            entry.libraryID === item.libraryID &&
            entry.itemKey === item.itemKey &&
            entry.version === 2 &&
            Boolean(entry.observationId),
        )
        .map((entry) => entry.sourceKind);
      if (kinds.some((kind) => ["body", "figure", "quote"].includes(kind))) {
        return "body";
      }
      if (kinds.includes("abstract")) return "abstract";
      if (kinds.includes("metadata")) return "metadata";
      return "none";
    })(),
  };
}

async function assertPlanDocumentPredecessorsComplete(
  ledger: PlanExecutionLedger,
  documentTaskId: string,
): Promise<void> {
  const otherTasks = ledger.tasks.filter(
    (entry) => entry.taskId !== documentTaskId,
  );
  const unresolvedTasks = otherTasks.filter(
    (entry) =>
      entry.status !== "completed" &&
      !(entry.kind === "required_step" && entry.status === "skipped") &&
      !(entry.kind === "supporting_child" && entry.status === "cancelled"),
  );
  if (unresolvedTasks.length) {
    throw new ToolInputRejection(
      "The formal document must be the final active plan task after all other approved work is verified complete",
    );
  }
  for (const completedTask of otherTasks.filter(
    (entry) => entry.status === "completed",
  )) {
    assertTaskCompletionEvidence(
      completedTask,
      await listTaskEvidence(ledger.executionId, completedTask.taskId),
    );
  }
}

export class PlanDocumentFinalizer {
  constructor(private readonly gateway: ZoteroGateway) {}

  async finalize(params: {
    executionId: string;
    activeTaskId: string;
    input: SubmitPlanDocumentInput;
    now?: number;
  }): Promise<{ document: PlanDocument; outbox: PlanDocumentOutboxRecord }> {
    const now = params.now ?? Date.now();
    const ledger = await loadPlanExecutionLedger(params.executionId);
    if (!ledger) throw new Error("Plan execution ledger not found");
    const priorDocument = await loadLatestPlanDocumentForExecution(
      params.executionId,
    );
    if (priorDocument) {
      const priorOrigin = getPlannedDocumentOrigin(priorDocument);
      if (
        !priorOrigin ||
        priorOrigin.executionId !== ledger.executionId ||
        priorOrigin.parentTaskId !== params.activeTaskId
      ) {
        throw new Error(
          "The prior document does not belong to the active Plan task",
        );
      }
      await assertPlanDocumentPredecessorsComplete(ledger, params.activeTaskId);
      const priorOutbox = await loadPlanDocumentOutbox(
        priorDocument.documentId,
      );
      if (!priorOutbox) {
        throw new Error(
          "The finalized document exists without its durable outbox",
        );
      }
      return { document: priorDocument, outbox: priorOutbox };
    }
    if (ledger.activeTaskId !== params.activeTaskId) {
      throw new Error(
        "Document finalization must belong to the active plan task",
      );
    }
    const task = ledger.tasks.find(
      (entry) => entry.taskId === params.activeTaskId,
    );
    if (!task) throw new Error("Document plan task not found");
    const integrityRequirement = task.completionRequirements?.find(
      (requirement) => requirement.kind === "document_integrity",
    );
    const publishRequirement = task.completionRequirements?.find(
      (requirement) => requirement.kind === "document_published",
    );
    if (!integrityRequirement || !publishRequirement) {
      throw new Error("The active task does not authorize a formal document");
    }
    const artifact = await loadPlanArtifact(ledger.planId, ledger.revision);
    if (
      !artifact ||
      artifact.digest !== ledger.planDigest ||
      artifact.contract?.deliverable.kind !== "document" ||
      !artifact.contractDigest
    ) {
      throw new Error(
        "The approved document contract is unavailable or changed",
      );
    }
    if (
      integrityRequirement.contractDigest !== artifact.contractDigest ||
      publishRequirement.contractDigest !== artifact.contractDigest
    ) {
      throw new Error(
        "Document requirements do not match the approved contract",
      );
    }
    const spec = artifact.contract.deliverable.spec;
    const researchJob = await loadResearchJobForExecution(params.executionId);
    if (artifact.contract.investigation && !researchJob) {
      throw new Error(
        "Research document cannot finalize without a research job",
      );
    }
    if (
      researchJob &&
      (researchJob.status !== "completed" || !researchJob.coverageStatus)
    ) {
      throw new ToolInputRejection("Research coverage is not terminal yet");
    }
    await assertPlanDocumentPredecessorsComplete(ledger, task.taskId);
    const effectiveSnapshotId =
      researchJob?.snapshotId ||
      artifact.contract.investigation?.scopeSnapshot?.snapshotId;
    const corpusSnapshot = effectiveSnapshotId
      ? await listScopeSnapshotItems(effectiveSnapshotId)
      : [];
    if (researchJob && corpusSnapshot.length !== researchJob.totalItems) {
      throw new Error("The effective research scope snapshot is incomplete");
    }
    const researchEvidence = researchJob
      ? await listResearchEvidence(researchJob.researchJobId)
      : [];
    const paperFindings = researchJob
      ? await listPaperFindings(researchJob.researchJobId)
      : [];
    const liveFingerprints = new Map<
      string,
      Awaited<ReturnType<typeof getResearchItemFingerprints>>
    >();
    const fingerprintFor = async (libraryID: number, itemKey: string) => {
      const identity = `${libraryID}:${itemKey}`;
      const cached = liveFingerprints.get(identity);
      if (cached) return cached;
      const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
      if (!item || item.deleted) {
        throw new Error(
          `Research source ${identity} is missing at finalization`,
        );
      }
      const fingerprints = await getResearchItemFingerprints(
        this.gateway,
        item.id,
      );
      liveFingerprints.set(identity, fingerprints);
      return fingerprints;
    };
    for (const evidence of researchEvidence) {
      const live = await fingerprintFor(evidence.libraryID, evidence.itemKey);
      const expected = ["body", "figure", "quote"].includes(evidence.sourceKind)
        ? live.attachmentFingerprint
        : live.metadataFingerprint;
      if (!expected || expected !== evidence.sourceFingerprint) {
        throw new Error(
          `Research evidence ${evidence.evidenceRef} changed after it was recorded`,
        );
      }
    }
    for (const finding of paperFindings) {
      const live = await fingerprintFor(finding.libraryID, finding.itemKey);
      if (
        finding.sourceFingerprint !== live.attachmentFingerprint &&
        finding.sourceFingerprint !== live.metadataFingerprint
      ) {
        throw new Error(
          `Paper finding ${finding.findingId} changed after it was recorded`,
        );
      }
    }
    const evidenceByRef = new Map(
      researchEvidence.map((entry) => [entry.evidenceRef, entry]),
    );
    const corpusKeys = new Set(
      corpusSnapshot.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const researchCorpus = researchJob
      ? await listResearchCorpusItems({
          researchJobId: researchJob.researchJobId,
        })
      : [];
    const coverageItems = researchCorpus.map((item) =>
      coverageItem(item, researchEvidence),
    );
    const researchEdges = researchJob
      ? await listResearchEdges(researchJob.researchJobId)
      : [];
    const documentVersion = await nextPlanDocumentVersion({
      planId: artifact.planId,
      planRevision: artifact.revision,
    });
    const documentId = `${artifact.planId}:r${artifact.revision}:document:${documentVersion}`;
    const finalized = await finalizeDocument({
      gateway: this.gateway,
      input: params.input,
      now,
      context: {
        documentId,
        documentVersion,
        conversationKey: ledger.conversationKey,
        integrityPolicy: artifact.contract.investigation
          ? "research_grounded"
          : "authored",
        origin: {
          kind: "planned",
          planId: artifact.planId,
          planRevision: artifact.revision,
          executionId: ledger.executionId,
          parentTaskId: task.taskId,
          contractDigest: artifact.contractDigest,
          scopeLineageDigest: researchJob?.scopeLineageDigest,
        },
        spec,
        corpus: corpusSnapshot,
        evidence: researchEvidence,
        quoteCorpusKeys: corpusKeys,
        coverageItems,
        coverageStatus: researchJob?.coverageStatus,
        ...(researchJob && artifact.contract.investigation
          ? {
              researchGraph: {
                edges: researchEdges,
                qualityReport: researchJob.qualityReport,
              },
            }
          : {}),
        validateAssetProvenance: async () => {
          for (const asset of params.input.assets) {
            if (asset.provenance.origin === "generated") {
              if (
                asset.provenance.evidenceRefs.some(
                  (reference) => !evidenceByRef.has(reference),
                )
              ) {
                throw new ToolInputRejection(
                  `Generated asset ${asset.assetId} references unknown research evidence`,
                );
              }
              continue;
            }
            if (
              !corpusKeys.has(
                `${asset.provenance.libraryID}:${asset.provenance.itemKey}`,
              )
            ) {
              throw new ToolInputRejection(
                `Extracted asset ${asset.assetId} is outside the approved corpus`,
              );
            }
            const provenance = asset.provenance;
            const trusted = researchEvidence.some(
              (entry) =>
                entry.libraryID === provenance.libraryID &&
                entry.itemKey === provenance.itemKey &&
                entry.sourceKind === "figure" &&
                entry.locator?.sourceFingerprint ===
                  provenance.sourceFingerprint &&
                entry.locator?.attachmentItemKey ===
                  provenance.attachmentItemKey &&
                entry.locator?.pageIndex === provenance.pageIndex,
            );
            if (!trusted) {
              throw new ToolInputRejection(
                `Extracted asset ${asset.assetId} lacks trusted figure provenance`,
              );
            }
          }
          if (params.input.assets.length) {
            const taskEvidence = (
              await Promise.all(
                ledger.tasks.map((entry) =>
                  listTaskEvidence(ledger.executionId, entry.taskId),
                ),
              )
            ).flat();
            const emittedArtifacts = taskEvidence
              .filter(
                (entry) =>
                  entry.verified && entry.payload?.type === "tool_artifacts",
              )
              .flatMap((entry) =>
                entry.payload?.type === "tool_artifacts"
                  ? entry.payload.artifacts
                  : [],
              );
            for (const asset of params.input.assets) {
              const expectedHash = asset.contentHash.replace(/^sha256:/, "");
              const trusted = emittedArtifacts.some(
                (artifact) =>
                  artifact.kind === "image" &&
                  artifact.storedPath === asset.durablePath &&
                  artifact.mimeType === asset.mimeType &&
                  (!artifact.contentHash ||
                    artifact.contentHash.replace(/^sha256:/, "") ===
                      expectedHash),
              );
              if (!trusted) {
                throw new ToolInputRejection(
                  `Document asset ${asset.assetId} was not emitted by a verified tool call in this execution`,
                );
              }
            }
          }
        },
      },
    });
    const { document } = finalized;
    // The rubric gains the document's cross-paper support numbers; it stays
    // on the job so the flight report and the progress card read one record.
    if (
      researchJob &&
      finalized.supportAudit &&
      artifact.contract.investigation
    ) {
      const [findings, questions, themes] = await Promise.all([
        listPaperFindings(researchJob.researchJobId),
        listResearchOpenQuestions(researchJob.researchJobId),
        listThemeFindings(
          researchJob.researchJobId,
          researchJob.scopeLineageDigest,
        ),
      ]);
      await saveResearchJob(
        {
          ...researchJob,
          qualityReport: computeResearchQualityReport({
            corpus: researchCorpus,
            findings,
            edges: researchEdges,
            questions,
            themes,
            subquestions: artifact.contract.investigation.subquestions,
            audit: finalized.supportAudit,
            now,
          }),
          updatedAt: Math.max(now, researchJob.updatedAt + 1),
        },
        ledger.conversationKey,
      );
    }
    const integrityEvidence: TaskEvidence = {
      version: 3,
      evidenceId: `${documentId}:integrity`,
      executionId: ledger.executionId,
      taskId: task.taskId,
      kind: "document_integrity",
      verified: true,
      requirementId: integrityRequirement.requirementId,
      criterionIds: integrityRequirement.criterionIds,
      contractDigest: integrityRequirement.contractDigest,
      payload: {
        type: "document_integrity",
        documentId: document.documentId,
        contentHash: document.contentHash,
        integrityValidated: true,
      },
      reference: document.contentHash,
      summary:
        "Document structure, citations, evidence links, and provenance passed deterministic integrity validation",
      createdAt: now,
    };
    await persistFinalizedDocument(finalized, integrityEvidence);
    return finalized;
  }
}
