import { ToolInputRejection } from "../tools/execution/failure";
import type { TaskEvidence, TrustedReadObservation } from "../plans/types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { validateObject } from "../tools/shared";
import { type ResearchUpdateInput } from "./commands";
import { buildNodeRecordFields, isNodeShapedFinding } from "./nodeRecords";
import { recordPaperExample } from "./recordDecoding";
import {
  resolveTrustedPdfLocator,
  selectPreferredVerifiedReads,
} from "./reading";
import {
  getTerminalScreeningDecisionError,
  NARRATIVE_ROLES,
  parseCriterionResults,
  positiveInt,
  safeId,
  SCREENING_STATUSES,
  string,
  strings,
} from "./recordValidation";
import { getResearchItemFingerprints } from "./scopeSnapshot";
import { buildExcludedScreeningFinding } from "./screeningBatch";
import { assertResearchCorpusUnchanged, commitResearchRecords } from "./stages";
import {
  savePaperFinding,
  saveResearchCorpusItem,
  saveResearchEvidence,
} from "./store";
import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEvidenceRecord,
  ResearchJob,
} from "./types";

import type { ResearchContract, ResearchScopeSnapshotItem } from "./types";
import type { CompleteResearchWorkItem } from "./work";

export async function recordResearchPapers(params: {
  taskEvidence: TaskEvidence[];
  corpusByKey: Map<string, ResearchCorpusItem>;
  job: ResearchJob;
  input: Extract<ResearchUpdateInput, { operation: "record_papers" }>;
  snapshotByKey: Map<string, ResearchScopeSnapshotItem>;
  completeWorkItem: CompleteResearchWorkItem;
  gateway: ZoteroGateway;
  adaptiveReview: boolean;
  allowedCriteria: Set<string>;
  investigation: ResearchContract;
  verifiedReads: Map<string, readonly TrustedReadObservation[]>;
  evidenceByRef: Map<string, ResearchEvidenceRecord>;
  newEvidenceRefs: Record<string, string>;
  allowedSubquestions: Set<string>;
}) {
  const {
    taskEvidence,
    corpusByKey,
    job,
    input,
    snapshotByKey,
    completeWorkItem,
    gateway,
    adaptiveReview,
    allowedCriteria,
    investigation,
    verifiedReads,
    evidenceByRef,
    newEvidenceRefs,
    allowedSubquestions,
  } = params;

  const preferredReads = selectPreferredVerifiedReads(
    taskEvidence,
    new Set(corpusByKey.keys()),
  );
  // Page indexes issued by trusted reads, per paper: the only locators a claim
  // may carry as host-verified.
  const observedPages = new Map<string, Set<number>>();
  for (const observations of verifiedReads.values()) {
    for (const observation of observations) {
      if (observation.pageIndex === undefined) continue;
      const key = `${observation.libraryID}:${observation.itemKey}`;
      const pages = observedPages.get(key) || new Set<number>();
      pages.add(observation.pageIndex);
      observedPages.set(key, pages);
    }
  }
  const writes: Array<() => Promise<unknown>> = [];
  for (let index = 0; index < (input.papers || []).length; index += 1) {
    // Identity and finding placement are normalized by `normalizeRecordPaperInput`
    // in the command validator; this loop reads an already-shaped paper.
    const raw = input.papers![index];
    const { libraryID, itemKey } = raw;
    const identity = `${libraryID}:${itemKey}`;
    const current = corpusByKey.get(identity);
    const approvedSource = snapshotByKey.get(identity);
    if (!current || !approvedSource) {
      throw new ToolInputRejection(
        `Paper ${identity} is outside the frozen corpus`,
      );
    }
    const liveItem = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    if (!liveItem || liveItem.deleted) {
      writes.push(async () =>
        saveResearchCorpusItem({
          ...current,
          screeningStatus: "missing",
          inventoryRecorded: true,
          hasAbstract: false,
          attachmentItemKeys: [],
          duplicateAttachmentKeys: [],
          readable: false,
          indexed: false,
          decisionReason: "Item is missing from the approved library snapshot",
          updatedAt: Date.now(),
        }),
      );
      writes.push(async () =>
        completeWorkItem({
          libraryID,
          itemKey,
          stage: job.activeStage,
        }),
      );
      continue;
    }
    const liveFingerprints = await getResearchItemFingerprints(
      gateway,
      liveItem.id,
    );
    const recordStage = job.activeStage;
    const status = (raw.screeningStatus ||
      (adaptiveReview
        ? current.readable
          ? "included"
          : current.hasAbstract
            ? "unresolved"
            : "unreadable"
        : undefined)) as ResearchCorpusItem["screeningStatus"];
    if (!SCREENING_STATUSES.has(status)) {
      throw new ToolInputRejection(
        `papers[${index}].screeningStatus is invalid`,
      );
    }
    const parsedCriterionResults = parseCriterionResults(
      raw.criterionResults || {},
      allowedCriteria,
      `papers[${index}].criterionResults`,
    );
    const missingCriteria = [...allowedCriteria].filter(
      (criterionId) => !parsedCriterionResults[criterionId],
    );
    if (missingCriteria.length) {
      throw new ToolInputRejection(
        `papers[${index}].criterionResults must include every approved criterion: ${[
          ...allowedCriteria,
        ].join(", ")}`,
      );
    }
    const decisionReason =
      typeof raw.decisionReason === "string"
        ? raw.decisionReason.trim() || undefined
        : undefined;
    const decisionError = getTerminalScreeningDecisionError({
      screeningStatus: status,
      criterionResults: parsedCriterionResults,
      decisionReason,
      criteria: investigation.criteria,
      totalItems: job.totalItems,
      deepReadPlanned: job.deepReadPlanned,
    });
    if (decisionError) {
      throw new ToolInputRejection(`papers[${index}] ${decisionError}`);
    }
    const evidenceKeyMap = new Map<string, string>();
    const preferredRead = preferredReads.get(identity);
    const rawEvidence = adaptiveReview
      ? preferredRead
        ? [
            {
              // One key per read depth keeps a metadata-first node upgradeable
              // to body evidence later; a single constant key would reject the
              // deeper record as "already used with different provenance".
              evidenceKey: `host_verified_read:${preferredRead.evidenceDepth}`,
              sourceKind: preferredRead.evidenceDepth,
              sourceReadRef: preferredRead.sourceReadRef,
            },
          ]
        : []
      : Array.isArray(raw.evidence)
        ? raw.evidence
        : [];
    for (
      let evidenceIndex = 0;
      evidenceIndex < rawEvidence.length;
      evidenceIndex += 1
    ) {
      const entry = rawEvidence[evidenceIndex];
      if (!validateObject<Record<string, unknown>>(entry)) {
        throw new ToolInputRejection(
          `papers[${index}].evidence[${evidenceIndex}] must be an object`,
        );
      }
      const evidenceKey = string(entry.evidenceKey, "evidenceKey");
      const sourceKind =
        entry.sourceKind as ResearchEvidenceRecord["sourceKind"];
      if (
        !new Set(["metadata", "abstract", "body", "figure", "quote"]).has(
          sourceKind,
        )
      ) {
        throw new ToolInputRejection(
          `Evidence ${evidenceKey} has an invalid sourceKind`,
        );
      }
      const sourceReadRef =
        typeof entry.sourceReadRef === "string"
          ? entry.sourceReadRef.trim()
          : "";
      const readObservations = verifiedReads.get(sourceReadRef) || [];
      const matchingReadObservations = readObservations.filter(
        (observation) =>
          observation.libraryID === libraryID &&
          observation.itemKey === itemKey &&
          observation.capabilities.includes(sourceKind),
      );
      if (!matchingReadObservations.length) {
        throw new ToolInputRejection(
          `Evidence ${evidenceKey} sourceKind ${sourceKind} was not issued by a trusted observation of ${identity}`,
        );
      }
      const trustedObservation = matchingReadObservations[0];
      const fingerprint = ["body", "figure", "quote"].includes(sourceKind)
        ? approvedSource.attachmentFingerprint
        : approvedSource.metadataFingerprint;
      const liveFingerprint = ["body", "figure", "quote"].includes(sourceKind)
        ? liveFingerprints.attachmentFingerprint
        : liveFingerprints.metadataFingerprint;
      if (!fingerprint || fingerprint !== liveFingerprint) {
        throw new ToolInputRejection(
          `Paper ${identity} changed after scope approval; revise or refresh the plan`,
        );
      }
      let locator: ResearchEvidenceRecord["locator"];
      if (entry.locator !== undefined) {
        if (!validateObject<Record<string, unknown>>(entry.locator)) {
          throw new ToolInputRejection(
            `Evidence ${evidenceKey} locator is invalid`,
          );
        }
        if (!["body", "figure", "quote"].includes(sourceKind)) {
          throw new ToolInputRejection(
            `Evidence ${evidenceKey} cannot attach a PDF locator to ${sourceKind}`,
          );
        }
        const attachmentItemKey = string(
          entry.locator.attachmentItemKey,
          "locator.attachmentItemKey",
        );
        const pageIndex = Math.max(
          0,
          Math.floor(Number(entry.locator.pageIndex)),
        );
        if (!Number.isFinite(Number(entry.locator.pageIndex))) {
          throw new ToolInputRejection(
            `Evidence ${evidenceKey} locator pageIndex is invalid`,
          );
        }
        locator = resolveTrustedPdfLocator({
          evidenceKey,
          sourceKind,
          requested: {
            attachmentItemKey,
            pageIndex,
          },
          observations: matchingReadObservations,
          fallbackFingerprint: fingerprint,
        });
      }
      const evidenceRef = `${job.researchJobId}:${libraryID}:${itemKey}:${safeId(evidenceKey)}`;
      const record: ResearchEvidenceRecord = {
        version: 2,
        evidenceRef,
        researchJobId: job.researchJobId,
        executionId: job.executionId,
        parentTaskId: job.parentTaskId,
        libraryID,
        itemKey,
        sourceFingerprint: fingerprint,
        sourceKind,
        observationId: trustedObservation.observationId,
        locator,
        createdAt: Date.now(),
      };
      const existing = evidenceByRef.get(evidenceRef);
      if (
        existing &&
        canonicalJson({ ...existing, createdAt: 0 }) !==
          canonicalJson({ ...record, createdAt: 0 })
      ) {
        throw new ToolInputRejection(
          `Evidence key ${evidenceKey} was already used with different provenance`,
        );
      }
      if (!existing) writes.push(async () => saveResearchEvidence(record));
      evidenceByRef.set(evidenceRef, existing || record);
      evidenceKeyMap.set(evidenceKey, evidenceRef);
      newEvidenceRefs[evidenceKey] = evidenceRef;
    }
    const next: ResearchCorpusItem = {
      ...current,
      screeningStatus: status,
      criterionResults: parsedCriterionResults,
      decisionReason,
      inventoryRecorded:
        current.inventoryRecorded || recordStage === "inventory",
      // Inventory and attachment identity are authoritative host state.
      // A model-produced paper understanding must never narrow or
      // otherwise rewrite the inventory that was frozen during the
      // scope pass.
      hasAbstract: current.hasAbstract,
      attachmentItemKeys: current.attachmentItemKeys,
      duplicateAttachmentKeys: current.duplicateAttachmentKeys,
      readable: current.readable,
      indexed: current.indexed,
      sourceFingerprint:
        liveFingerprints.attachmentFingerprint ||
        liveFingerprints.metadataFingerprint,
      updatedAt: Date.now(),
    };
    let workSubquestions: string[] = [];
    if (validateObject<Record<string, unknown>>(raw.finding)) {
      const finding = raw.finding;
      // Jobs with a comparison frame record claim-based nodes; an included
      // paper of such a job must be written in that shape.
      const nodeFields =
        adaptiveReview &&
        job.frame &&
        (status === "included" || isNodeShapedFinding(finding))
          ? buildNodeRecordFields({
              identity,
              itemKey,
              finding,
              frame: job.frame,
              tier: current.tier || "core",
              readDepth: preferredRead?.evidenceDepth,
              observedPageIndexes: observedPages.get(identity) || new Set(),
              corpusIdentities: new Set(corpusByKey.keys()),
              allowedSubquestions,
            })
          : undefined;
      if (nodeFields && nodeFields.tier !== current.tier) {
        Object.assign(next, {
          version: 2,
          tier: nodeFields.tier,
          tierSource: "model",
        });
      }
      writes.push(async () => saveResearchCorpusItem(next));
      const subquestionIds = nodeFields
        ? [...nodeFields.subquestionIds]
        : adaptiveReview && finding.subquestionIds === undefined
          ? [...allowedSubquestions]
          : strings(finding.subquestionIds, "finding.subquestionIds");
      workSubquestions = subquestionIds;
      const criterionIds =
        adaptiveReview && finding.criterionIds === undefined
          ? []
          : strings(finding.criterionIds, "finding.criterionIds");
      if (subquestionIds.some((id) => !allowedSubquestions.has(id))) {
        throw new ToolInputRejection(
          `Finding for ${identity} references an unknown subquestion\n${recordPaperExample()}`,
        );
      }
      if (criterionIds.some((id) => !allowedCriteria.has(id))) {
        throw new ToolInputRejection(
          `Finding for ${identity} references an unknown criterion\n${recordPaperExample()}`,
        );
      }
      const evidenceKeys = [...evidenceKeyMap.keys()];
      const mappedEvidence = evidenceKeys.map(
        (key) => evidenceKeyMap.get(key) || key,
      );
      for (const evidenceRef of mappedEvidence) {
        const evidence = evidenceByRef.get(evidenceRef);
        if (
          !evidence ||
          evidence.libraryID !== libraryID ||
          evidence.itemKey !== itemKey
        ) {
          throw new ToolInputRejection(
            `Finding for ${identity} has invalid evidence ${evidenceRef}`,
          );
        }
      }
      const inclusionDecision = (finding.inclusionDecision ||
        (adaptiveReview
          ? status === "included"
            ? "include"
            : "unresolved"
          : undefined)) as PaperFinding["inclusionDecision"];
      const confidence = finding.confidence as PaperFinding["confidence"];
      if (
        !new Set(["include", "exclude", "unresolved"]).has(inclusionDecision)
      ) {
        throw new ToolInputRejection(
          `Finding for ${identity} has invalid inclusionDecision\n${recordPaperExample()}`,
        );
      }
      if (!new Set(["low", "medium", "high"]).has(confidence)) {
        throw new ToolInputRejection(
          `Finding for ${identity} has invalid confidence\n${recordPaperExample()}`,
        );
      }
      const roles =
        finding.roles === undefined
          ? adaptiveReview
            ? status === "included"
              ? ["supporting_evidence"]
              : ["unresolved"]
            : undefined
          : strings(finding.roles, "finding.roles");
      if (
        roles?.some(
          (role) => !(NARRATIVE_ROLES as readonly string[]).includes(role),
        )
      ) {
        throw new ToolInputRejection(
          `Finding for ${identity} has an invalid role\n${recordPaperExample()}`,
        );
      }
      if (adaptiveReview && status === "included") {
        for (const field of nodeFields
          ? (["mainMessage", "relevance"] as const)
          : ([
              "mainMessage",
              "researchQuestion",
              "method",
              "relevance",
            ] as const)) {
          string(finding[field], `finding.${field}`);
        }
      }
      const record: PaperFinding = {
        version: nodeFields ? 2 : 1,
        findingId: `${job.researchJobId}:paper:${libraryID}:${itemKey}`,
        researchJobId: job.researchJobId,
        executionId: job.executionId,
        parentTaskId: job.parentTaskId,
        libraryID,
        itemKey,
        subquestionIds,
        criterionIds,
        findings: nodeFields
          ? [...nodeFields.findings]
          : strings(finding.findings || [], "finding.findings"),
        contradictions: strings(
          finding.contradictions || [],
          "finding.contradictions",
        ),
        negativeEvidence: strings(
          finding.negativeEvidence || [],
          "finding.negativeEvidence",
        ),
        limitations: nodeFields
          ? [...nodeFields.limitations]
          : strings(finding.limitations || [], "finding.limitations"),
        evidenceRefs: mappedEvidence,
        sourceFingerprint: next.sourceFingerprint || "missing",
        inclusionDecision,
        confidence,
        unresolvedQuestions: strings(
          finding.unresolvedQuestions || [],
          "finding.unresolvedQuestions",
        ),
        ...(roles
          ? {
              roles: roles as NonNullable<PaperFinding["roles"]>,
            }
          : {}),
        ...(finding.mainMessage === undefined
          ? {}
          : {
              mainMessage: string(finding.mainMessage, "finding.mainMessage"),
            }),
        ...(nodeFields?.researchQuestion
          ? { researchQuestion: nodeFields.researchQuestion }
          : finding.researchQuestion === undefined
            ? {}
            : {
                researchQuestion: string(
                  finding.researchQuestion,
                  "finding.researchQuestion",
                ),
              }),
        ...(nodeFields?.method
          ? { method: nodeFields.method }
          : finding.method === undefined
            ? {}
            : { method: string(finding.method, "finding.method") }),
        ...(nodeFields
          ? { mechanisms: [...nodeFields.mechanisms] }
          : finding.mechanisms === undefined
            ? {}
            : {
                mechanisms: strings(finding.mechanisms, "finding.mechanisms"),
              }),
        ...(finding.relevance === undefined
          ? {}
          : {
              relevance: string(finding.relevance, "finding.relevance"),
            }),
        ...(finding.relationships === undefined
          ? {}
          : {
              relationships: strings(
                finding.relationships,
                "finding.relationships",
              ),
            }),
        ...(nodeFields
          ? {
              tier: nodeFields.tier,
              frameSlots: nodeFields.frameSlots,
              claims: nodeFields.claims,
              hooks: nodeFields.hooks,
              ...(nodeFields.candidateLinks
                ? { candidateLinks: nodeFields.candidateLinks }
                : {}),
              ...(nodeFields.noLinkSeen
                ? { noLinkSeen: nodeFields.noLinkSeen }
                : {}),
              ...(nodeFields.questionsRaised
                ? { questionsRaised: nodeFields.questionsRaised }
                : {}),
            }
          : {}),
        createdAt: Date.now(),
      };
      writes.push(async () => savePaperFinding(record));
    } else if (adaptiveReview && status !== "missing") {
      throw new ToolInputRejection(
        `Adaptive review paper ${identity} requires a durable finding\n${recordPaperExample()}`,
      );
    } else if (recordStage === "broad_screening" && status === "excluded") {
      writes.push(async () => saveResearchCorpusItem(next));
      writes.push(async () =>
        savePaperFinding(
          buildExcludedScreeningFinding({
            researchJobId: job.researchJobId,
            executionId: job.executionId,
            parentTaskId: job.parentTaskId,
            libraryID,
            itemKey,
            criterionIds: [...allowedCriteria],
            decisionReason: next.decisionReason,
            sourceFingerprint: next.sourceFingerprint || "missing",
          }),
        ),
      );
    } else {
      writes.push(async () => saveResearchCorpusItem(next));
    }
    writes.push(async () =>
      completeWorkItem({
        libraryID,
        itemKey,
        stage: job.activeStage,
        evidenceRefs: [...evidenceKeyMap.values()],
        subquestionIds: workSubquestions,
      }),
    );
  }
  await commitResearchRecords(job, async () => {
    await assertResearchCorpusUnchanged(job, [...corpusByKey.values()]);
    for (const write of writes) await write();
  });
}
