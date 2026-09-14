import { decodeActionContract } from "../plans/contracts";
import {
  decodeResearchCandidateLink,
  decodeResearchClaim,
  decodeResearchFrame,
  decodeResearchNodeCapacity,
  decodeResearchNodeHooks,
  decodeResearchQualityReport,
  RESEARCH_PAPER_TIERS,
  RESEARCH_SYNTHESIS_PHASES,
} from "./graphSchema";
import { decodeResearchPolicySnapshot } from "./policy";
import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEvidenceRecord,
  ResearchJob,
  ResearchMutationApprovalGrant,
  ResearchRecallProbe,
  ResearchScopeSnapshotItem,
  ResearchWorkItem,
  ThemeFinding,
} from "./types";

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

function positiveInteger(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

export function decodeScopeSnapshotItem(
  value: unknown,
): ResearchScopeSnapshotItem {
  const input = object(value, "scope snapshot item");
  return {
    snapshotId: string(input.snapshotId, "snapshotId"),
    libraryID: positiveInteger(input.libraryID, "libraryID"),
    itemKey: string(input.itemKey, "itemKey"),
    localItemId:
      input.localItemId === undefined
        ? undefined
        : positiveInteger(input.localItemId, "localItemId"),
    title: typeof input.title === "string" ? input.title : undefined,
    firstCreator:
      typeof input.firstCreator === "string" ? input.firstCreator : undefined,
    year: typeof input.year === "string" ? input.year : undefined,
    metadataFingerprint:
      typeof input.metadataFingerprint === "string"
        ? input.metadataFingerprint
        : undefined,
    attachmentFingerprint:
      typeof input.attachmentFingerprint === "string"
        ? input.attachmentFingerprint
        : undefined,
    ordinal: nonNegativeInteger(input.ordinal, "ordinal"),
  };
}

export function decodeResearchJob(value: unknown): ResearchJob {
  const input = object(value, "research job");
  if (input.version !== 1 && input.version !== 2 && input.version !== 3) {
    throw new Error("Unsupported research job version");
  }
  if (
    input.synthesisPhase !== undefined &&
    !RESEARCH_SYNTHESIS_PHASES.includes(
      input.synthesisPhase as ResearchJob["synthesisPhase"] & string,
    )
  ) {
    throw new Error("Invalid research synthesis phase");
  }
  const policy = decodeResearchPolicySnapshot(input.policy);
  const statuses = new Set([
    "pending",
    "running",
    "waiting_for_user",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
  ]);
  if (!statuses.has(String(input.status))) {
    throw new Error("Invalid research job status");
  }
  const coverageStatuses = new Set([
    "complete",
    "complete_with_limitations",
    "partial",
    "failed",
  ]);
  if (
    input.coverageStatus !== undefined &&
    !coverageStatuses.has(String(input.coverageStatus))
  ) {
    throw new Error("Invalid research coverage status");
  }
  const stages = new Set(policy.stages);
  if (!stages.has(input.activeStage as ResearchJob["activeStage"])) {
    throw new Error("Invalid research stage");
  }
  const grantInput =
    input.exceptionGrant === undefined
      ? undefined
      : object(input.exceptionGrant, "exceptionGrant");
  if (
    grantInput &&
    (grantInput.version !== 1 ||
      (grantInput.status !== "authorized" && grantInput.status !== "consumed"))
  ) {
    throw new Error("Invalid research exception grant");
  }
  return {
    version: input.version,
    researchJobId: string(input.researchJobId, "researchJobId"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    contractDigest: string(input.contractDigest, "contractDigest"),
    baseSnapshotId:
      input.version >= 2
        ? string(input.baseSnapshotId, "baseSnapshotId")
        : string(input.snapshotId, "snapshotId"),
    snapshotId: string(input.snapshotId, "snapshotId"),
    scopeLineageDigest:
      input.version >= 2
        ? string(input.scopeLineageDigest, "scopeLineageDigest")
        : `legacy:${string(input.snapshotId, "snapshotId")}`,
    policy,
    status: input.status as ResearchJob["status"],
    activeStage: input.activeStage as ResearchJob["activeStage"],
    coverageStatus: input.coverageStatus as ResearchJob["coverageStatus"],
    totalItems: nonNegativeInteger(input.totalItems, "totalItems"),
    screenedItems: nonNegativeInteger(input.screenedItems, "screenedItems"),
    candidateItems: nonNegativeInteger(input.candidateItems, "candidateItems"),
    deepReadCompleted: nonNegativeInteger(
      input.deepReadCompleted,
      "deepReadCompleted",
    ),
    deepReadPlanned: nonNegativeInteger(
      input.deepReadPlanned,
      "deepReadPlanned",
    ),
    exceptionGrant: grantInput
      ? {
          version: 1,
          grantId: string(grantInput.grantId, "exceptionGrant.grantId"),
          planDigest: string(
            grantInput.planDigest,
            "exceptionGrant.planDigest",
          ),
          executionId: string(
            grantInput.executionId,
            "exceptionGrant.executionId",
          ),
          researchJobId: string(
            grantInput.researchJobId,
            "exceptionGrant.researchJobId",
          ),
          totalItems: nonNegativeInteger(
            grantInput.totalItems,
            "exceptionGrant.totalItems",
          ),
          screenedItems: nonNegativeInteger(
            grantInput.screenedItems,
            "exceptionGrant.screenedItems",
          ),
          candidateItems: nonNegativeInteger(
            grantInput.candidateItems,
            "exceptionGrant.candidateItems",
          ),
          deepReadCompleted: nonNegativeInteger(
            grantInput.deepReadCompleted,
            "exceptionGrant.deepReadCompleted",
          ),
          limitationSummary: string(
            grantInput.limitationSummary,
            "exceptionGrant.limitationSummary",
          ),
          status: grantInput.status as "authorized" | "consumed",
          grantedAt: number(grantInput.grantedAt, "exceptionGrant.grantedAt"),
          consumedAt:
            grantInput.consumedAt === undefined
              ? undefined
              : number(grantInput.consumedAt, "exceptionGrant.consumedAt"),
        }
      : undefined,
    ...(input.frame === undefined
      ? {}
      : { frame: decodeResearchFrame(input.frame) }),
    ...(input.synthesisPhase === undefined
      ? {}
      : {
          synthesisPhase: input.synthesisPhase as ResearchJob["synthesisPhase"],
        }),
    ...(input.nodeCapacity === undefined
      ? {}
      : { nodeCapacity: decodeResearchNodeCapacity(input.nodeCapacity) }),
    ...(input.qualityReport === undefined
      ? {}
      : { qualityReport: decodeResearchQualityReport(input.qualityReport) }),
    createdAt: number(input.createdAt, "createdAt"),
    updatedAt: number(input.updatedAt, "updatedAt"),
    completedAt:
      input.completedAt === undefined
        ? undefined
        : number(input.completedAt, "completedAt"),
  };
}

export function decodeResearchCorpusItem(value: unknown): ResearchCorpusItem {
  const input = object(value, "research corpus item");
  if (input.version !== 1 && input.version !== 2) {
    throw new Error("Unsupported corpus item version");
  }
  if (
    input.tier !== undefined &&
    !RESEARCH_PAPER_TIERS.includes(
      input.tier as ResearchCorpusItem["tier"] & string,
    )
  ) {
    throw new Error("Invalid corpus item tier");
  }
  if (
    input.tierSource !== undefined &&
    input.tierSource !== "host" &&
    input.tierSource !== "model"
  ) {
    throw new Error("Invalid corpus item tier source");
  }
  const statuses = new Set([
    "pending",
    "candidate",
    "included",
    "excluded",
    "unresolved",
    "unreadable",
    "missing",
  ]);
  if (!statuses.has(String(input.screeningStatus))) {
    throw new Error("Invalid corpus screening status");
  }
  const rawCriterionResults = object(
    input.criterionResults,
    "criterionResults",
  );
  const criterionResults: Record<string, "met" | "not_met" | "unknown"> = {};
  for (const [criterionId, result] of Object.entries(rawCriterionResults)) {
    if (
      !criterionId.trim() ||
      !["met", "not_met", "unknown"].includes(String(result))
    ) {
      throw new Error(`Invalid criterion result ${criterionId || "(empty)"}`);
    }
    criterionResults[criterionId] = result as "met" | "not_met" | "unknown";
  }
  const attachmentItemKeys = strings(
    input.attachmentItemKeys,
    "attachmentItemKeys",
  );
  const duplicateAttachmentKeys = strings(
    input.duplicateAttachmentKeys,
    "duplicateAttachmentKeys",
  );
  if (
    new Set(attachmentItemKeys).size !== attachmentItemKeys.length ||
    new Set(duplicateAttachmentKeys).size !== duplicateAttachmentKeys.length ||
    duplicateAttachmentKeys.some((key) => !attachmentItemKeys.includes(key))
  ) {
    throw new Error("Corpus attachment inventory is invalid");
  }
  return {
    version: input.version,
    researchJobId: string(input.researchJobId, "researchJobId"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    libraryID: positiveInteger(input.libraryID, "libraryID"),
    itemKey: string(input.itemKey, "itemKey"),
    localItemId:
      input.localItemId === undefined
        ? undefined
        : positiveInteger(input.localItemId, "localItemId"),
    ordinal: nonNegativeInteger(input.ordinal, "ordinal"),
    screeningStatus:
      input.screeningStatus as ResearchCorpusItem["screeningStatus"],
    criterionResults,
    decisionReason:
      typeof input.decisionReason === "string"
        ? input.decisionReason
        : undefined,
    inventoryRecorded: input.inventoryRecorded === true,
    hasAbstract: input.hasAbstract === true,
    attachmentItemKeys,
    duplicateAttachmentKeys,
    readable: input.readable === true,
    indexed: input.indexed === true,
    sourceFingerprint:
      typeof input.sourceFingerprint === "string"
        ? input.sourceFingerprint
        : undefined,
    ...(input.tier === undefined
      ? {}
      : { tier: input.tier as ResearchCorpusItem["tier"] }),
    ...(input.relevanceScore === undefined
      ? {}
      : { relevanceScore: number(input.relevanceScore, "relevanceScore") }),
    ...(input.tierSource === undefined
      ? {}
      : { tierSource: input.tierSource as "host" | "model" }),
    ...(typeof input.tierReason === "string"
      ? { tierReason: input.tierReason }
      : {}),
    ...(input.textTokens === undefined
      ? {}
      : { textTokens: nonNegativeInteger(input.textTokens, "textTokens") }),
    updatedAt: number(input.updatedAt, "updatedAt"),
  };
}

export function decodeResearchWorkItem(value: unknown): ResearchWorkItem {
  const input = object(value, "research work item");
  if (input.version !== 1) throw new Error("Unsupported work item version");
  const stages = new Set([
    "inventory",
    "broad_screening",
    "recall_expansion",
    "deep_evidence",
    "paper_findings",
    "hierarchical_synthesis",
  ]);
  const statuses = new Set([
    "pending",
    "in_progress",
    "completed",
    "blocked",
    "interrupted",
    "cancelled",
  ]);
  if (!stages.has(String(input.stage)))
    throw new Error("Invalid work item stage");
  if (!statuses.has(String(input.status)))
    throw new Error("Invalid work item status");
  return {
    version: 1,
    workItemId: string(input.workItemId, "workItemId"),
    researchJobId: string(input.researchJobId, "researchJobId"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    libraryID: positiveInteger(input.libraryID, "libraryID"),
    itemKey: string(input.itemKey, "itemKey"),
    stage: input.stage as ResearchWorkItem["stage"],
    subquestionIds: strings(input.subquestionIds, "subquestionIds"),
    status: input.status as ResearchWorkItem["status"],
    attemptCount: nonNegativeInteger(input.attemptCount, "attemptCount"),
    leaseOwner:
      typeof input.leaseOwner === "string" ? input.leaseOwner : undefined,
    leaseExpiresAt:
      input.leaseExpiresAt === undefined
        ? undefined
        : number(input.leaseExpiresAt, "leaseExpiresAt"),
    evidenceRefs: strings(input.evidenceRefs, "evidenceRefs"),
    failureReason:
      typeof input.failureReason === "string" ? input.failureReason : undefined,
    createdAt: number(input.createdAt, "createdAt"),
    updatedAt: number(input.updatedAt, "updatedAt"),
  };
}

export function decodeResearchEvidenceRecord(
  value: unknown,
): ResearchEvidenceRecord {
  const input = object(value, "research evidence record");
  if (input.version !== 1 && input.version !== 2)
    throw new Error("Unsupported evidence record version");
  const sourceKinds = new Set([
    "metadata",
    "abstract",
    "body",
    "figure",
    "quote",
  ]);
  if (!sourceKinds.has(String(input.sourceKind))) {
    throw new Error("Invalid research evidence source kind");
  }
  const locatorInput =
    input.locator === undefined ? undefined : object(input.locator, "locator");
  const locator = locatorInput
    ? {
        kind: "pdf_page" as const,
        attachmentItemKey: string(
          locatorInput.attachmentItemKey,
          "locator.attachmentItemKey",
        ),
        pageIndex: nonNegativeInteger(
          locatorInput.pageIndex,
          "locator.pageIndex",
        ),
        sourceFingerprint: string(
          locatorInput.sourceFingerprint,
          "locator.sourceFingerprint",
        ),
      }
    : undefined;
  return {
    version: input.version,
    evidenceRef: string(input.evidenceRef, "evidenceRef"),
    researchJobId: string(input.researchJobId, "researchJobId"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    libraryID: positiveInteger(input.libraryID, "libraryID"),
    itemKey: string(input.itemKey, "itemKey"),
    sourceFingerprint: string(input.sourceFingerprint, "sourceFingerprint"),
    sourceKind: input.sourceKind as ResearchEvidenceRecord["sourceKind"],
    observationId:
      input.version === 2
        ? string(input.observationId, "observationId")
        : undefined,
    locator,
    createdAt: number(input.createdAt, "createdAt"),
  };
}

export function decodeResearchRecallProbe(value: unknown): ResearchRecallProbe {
  const input = object(value, "research recall probe");
  if (input.version !== 1) throw new Error("Unsupported recall probe version");
  if (
    !new Set([
      "synonym",
      "abbreviation",
      "translation",
      "semantic",
      "reformulation",
    ]).has(String(input.kind))
  ) {
    throw new Error("Invalid research recall probe kind");
  }
  if (!Array.isArray(input.addedTargets)) {
    throw new Error("Recall probe addedTargets must be an array");
  }
  return {
    version: 1,
    probeId: string(input.probeId, "probeId"),
    researchJobId: string(input.researchJobId, "researchJobId"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    kind: input.kind as ResearchRecallProbe["kind"],
    query: string(input.query, "query"),
    addedTargets: input.addedTargets.map((target, index) => {
      const entry = object(target, `addedTargets[${index}]`);
      return {
        libraryID: positiveInteger(
          entry.libraryID,
          `addedTargets[${index}].libraryID`,
        ),
        itemKey: string(entry.itemKey, `addedTargets[${index}].itemKey`),
      };
    }),
    createdAt: number(input.createdAt, "createdAt"),
  };
}

export function decodePaperFinding(value: unknown): PaperFinding {
  const input = object(value, "paper finding");
  if (input.version !== 1 && input.version !== 2) {
    throw new Error("Unsupported paper finding version");
  }
  if (
    input.tier !== undefined &&
    !RESEARCH_PAPER_TIERS.includes(input.tier as PaperFinding["tier"] & string)
  ) {
    throw new Error("Invalid paper-finding tier");
  }
  const frameSlots =
    input.frameSlots === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(object(input.frameSlots, "frameSlots")).map(
            ([slotId, slotValue]) => [
              slotId,
              typeof slotValue === "string"
                ? slotValue
                : String(slotValue ?? ""),
            ],
          ),
        );
  const claims =
    input.claims === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(input.claims)) {
            throw new Error("claims must be an array");
          }
          return input.claims.map((entry, index) =>
            decodeResearchClaim(entry, `claims[${index}]`),
          );
        })();
  const candidateLinks =
    input.candidateLinks === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(input.candidateLinks)) {
            throw new Error("candidateLinks must be an array");
          }
          return input.candidateLinks.map((entry, index) =>
            decodeResearchCandidateLink(entry, `candidateLinks[${index}]`),
          );
        })();
  const questionsRaised =
    input.questionsRaised === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(input.questionsRaised)) {
            throw new Error("questionsRaised must be an array");
          }
          return input.questionsRaised.map((entry, index) => {
            const question = object(entry, `questionsRaised[${index}]`);
            return {
              text: string(question.text, `questionsRaised[${index}].text`),
              ...(typeof question.about === "string" && question.about
                ? { about: question.about }
                : {}),
            };
          });
        })();
  if (
    !new Set(["include", "exclude", "unresolved"]).has(
      String(input.inclusionDecision),
    )
  ) {
    throw new Error("Invalid paper-finding inclusion decision");
  }
  if (!new Set(["low", "medium", "high"]).has(String(input.confidence))) {
    throw new Error("Invalid paper-finding confidence");
  }
  const roles =
    input.roles === undefined ? undefined : strings(input.roles, "roles");
  const allowedRoles = new Set([
    "central_evidence",
    "supporting_evidence",
    "contradictory_evidence",
    "theoretical_foundation",
    "methodological_contribution",
    "historical_context",
    "tangential_context",
    "unresolved",
  ]);
  if (roles?.some((role) => !allowedRoles.has(role))) {
    throw new Error("Invalid paper-finding role");
  }
  return {
    version: input.version,
    findingId: string(input.findingId, "findingId"),
    researchJobId: string(input.researchJobId, "researchJobId"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    libraryID: positiveInteger(input.libraryID, "libraryID"),
    itemKey: string(input.itemKey, "itemKey"),
    subquestionIds: strings(input.subquestionIds, "subquestionIds"),
    criterionIds: strings(input.criterionIds, "criterionIds"),
    findings: strings(input.findings, "findings"),
    contradictions: strings(input.contradictions, "contradictions"),
    negativeEvidence: strings(input.negativeEvidence, "negativeEvidence"),
    limitations: strings(input.limitations, "limitations"),
    evidenceRefs: strings(input.evidenceRefs, "evidenceRefs"),
    sourceFingerprint: string(input.sourceFingerprint, "sourceFingerprint"),
    inclusionDecision:
      input.inclusionDecision as PaperFinding["inclusionDecision"],
    confidence: input.confidence as PaperFinding["confidence"],
    unresolvedQuestions: strings(
      input.unresolvedQuestions,
      "unresolvedQuestions",
    ),
    ...(roles ? { roles: roles as NonNullable<PaperFinding["roles"]> } : {}),
    ...(input.mainMessage === undefined
      ? {}
      : { mainMessage: string(input.mainMessage, "mainMessage") }),
    ...(input.researchQuestion === undefined
      ? {}
      : {
          researchQuestion: string(input.researchQuestion, "researchQuestion"),
        }),
    ...(input.method === undefined
      ? {}
      : { method: string(input.method, "method") }),
    ...(input.mechanisms === undefined
      ? {}
      : { mechanisms: strings(input.mechanisms, "mechanisms") }),
    ...(input.relevance === undefined
      ? {}
      : { relevance: string(input.relevance, "relevance") }),
    ...(input.relationships === undefined
      ? {}
      : { relationships: strings(input.relationships, "relationships") }),
    ...(input.tier === undefined
      ? {}
      : { tier: input.tier as PaperFinding["tier"] }),
    ...(frameSlots ? { frameSlots } : {}),
    ...(claims ? { claims } : {}),
    ...(input.hooks === undefined
      ? {}
      : { hooks: decodeResearchNodeHooks(input.hooks) }),
    ...(candidateLinks ? { candidateLinks } : {}),
    ...(typeof input.noLinkSeen === "string" && input.noLinkSeen.trim()
      ? { noLinkSeen: input.noLinkSeen.trim() }
      : {}),
    ...(questionsRaised ? { questionsRaised } : {}),
    createdAt: number(input.createdAt, "createdAt"),
  };
}

export function decodeThemeFinding(value: unknown): ThemeFinding {
  const input = object(value, "theme finding");
  if (input.version !== 1 && input.version !== 2) {
    throw new Error("Unsupported theme finding version");
  }
  if (
    input.status !== undefined &&
    input.status !== "valid" &&
    input.status !== "invalidated"
  ) {
    throw new Error("Invalid theme finding status");
  }
  if (input.version === 2 && input.status === undefined) {
    throw new Error("Theme finding v2 requires lifecycle status");
  }
  return {
    version: input.version,
    themeFindingId: string(input.themeFindingId, "themeFindingId"),
    researchJobId: string(input.researchJobId, "researchJobId"),
    executionId: string(input.executionId, "executionId"),
    parentTaskId: string(input.parentTaskId, "parentTaskId"),
    title: string(input.title, "title"),
    synthesis: string(input.synthesis, "synthesis"),
    paperFindingIds: strings(input.paperFindingIds, "paperFindingIds"),
    evidenceRefs: strings(input.evidenceRefs, "evidenceRefs"),
    limitations: strings(input.limitations, "limitations"),
    ...(input.edgeIds === undefined
      ? {}
      : { edgeIds: strings(input.edgeIds, "edgeIds") }),
    ...(typeof input.communityId === "string" && input.communityId
      ? { communityId: input.communityId }
      : {}),
    scopeLineageDigest:
      input.version === 2
        ? string(input.scopeLineageDigest, "scopeLineageDigest")
        : undefined,
    status:
      input.version === 2
        ? (input.status as ThemeFinding["status"])
        : undefined,
    invalidatedAt:
      input.invalidatedAt === undefined
        ? undefined
        : number(input.invalidatedAt, "invalidatedAt"),
    createdAt: number(input.createdAt, "createdAt"),
  };
}

export function decodeResearchMutationApprovalGrant(
  value: unknown,
): ResearchMutationApprovalGrant {
  const input = object(value, "research mutation approval grant");
  if (input.version !== 1 && input.version !== 2 && input.version !== 3) {
    throw new Error("Unsupported research mutation approval grant version");
  }
  if (input.status !== "approved" && input.status !== "invalidated") {
    throw new Error("Invalid research mutation approval grant status");
  }
  if (
    input.version === 3 &&
    !["user", "auto_policy", "yolo"].includes(String(input.authority))
  )
    throw new Error("Research mutation authority is invalid");
  return {
    version: input.version,
    ...(input.version === 3
      ? { authority: input.authority as "user" | "auto_policy" | "yolo" }
      : {}),
    grantId: string(input.grantId, "grantId"),
    planId: string(input.planId, "planId"),
    planRevision: number(input.planRevision, "planRevision"),
    executionId: string(input.executionId, "executionId"),
    conversationKey: number(input.conversationKey, "conversationKey"),
    planDigest: string(input.planDigest, "planDigest"),
    researchResultDigest: string(
      input.researchResultDigest,
      "researchResultDigest",
    ),
    scopeLineageDigest:
      input.version >= 2
        ? string(input.scopeLineageDigest, "scopeLineageDigest")
        : undefined,
    targetSetDigest: string(input.targetSetDigest, "targetSetDigest"),
    actionContract: decodeActionContract(input.actionContract),
    status: input.status,
    approvedAt: number(input.approvedAt, "approvedAt"),
    invalidatedAt:
      input.invalidatedAt === undefined
        ? undefined
        : number(input.invalidatedAt, "invalidatedAt"),
  };
}

export { decodeResearchEdge, decodeResearchOpenQuestion } from "./graphSchema";
