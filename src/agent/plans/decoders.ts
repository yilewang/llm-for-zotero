import { isActionIndexList } from "../contracts/workflowDependencies";
import type {
  ExecutionTask,
  ExecutionTaskStatus,
  PlanArtifact,
  PlanAcceptanceCriterion,
  PlanArtifactStatus,
  PlanCompletionRequirement,
  PlanCompletionRequirementKind,
  PlanExecutionLedger,
  PlanExecutionStatus,
  PlanProvider,
  PlanStep,
  PlanStepEffect,
  TaskEvidence,
  TaskEvidenceKind,
  TaskEvidencePayload,
} from "./types";
import type { PlanSkillRoutingReceipt } from "../skills/routingTypes";
import {
  decodeActionContract,
  decodeActionReceipt,
  decodePlanContract,
} from "./contracts";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requiredInteger(
  value: unknown,
  label: string,
  minimum: number,
): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) =>
    requiredString(entry, `${label}[${index}]`),
  );
}

const PROVIDERS = new Set<PlanProvider>(["original", "codex", "claude"]);
const ARTIFACT_STATUSES = new Set<PlanArtifactStatus>([
  "drafting",
  "awaiting_approval",
  "approved",
  "superseded",
  "cancelled",
]);
const STEP_EFFECTS = new Set<PlanStepEffect>([
  "read",
  "artifact",
  "mutation",
  "reasoning",
]);
const REQUIREMENT_KINDS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "bounded_reasoning",
  "research_coverage",
  "material_integrity",
  "document_integrity",
  "document_published",
  "mutation_receipts",
  "user_decision",
]);
const TASK_STATUSES = new Set<ExecutionTaskStatus>([
  "pending",
  "in_progress",
  "waiting_for_user",
  "interrupted",
  "completed",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
]);
const EXECUTION_STATUSES = new Set<PlanExecutionStatus>([
  "pending",
  "running",
  "waiting_for_user",
  "interrupted",
  "completed",
  "completed_with_exceptions",
  "blocked",
  "failed",
  "cancelled",
  "superseded",
]);
const EVIDENCE_KINDS = new Set<TaskEvidenceKind>([
  "mutation_receipt",
  "verified_read",
  "artifact",
  "validation",
  "reasoning_assertion",
  "research_coverage",
  "material_integrity",
  "document_integrity",
  "document_published",
  "user_decision",
]);

function decodeAcceptanceCriteria(
  value: unknown,
  label: string,
  typed: boolean,
): Array<string | PlanAcceptanceCriterion> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (!typed) return stringList(value, label);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const input = requiredRecord(entry, `${label}[${index}]`);
    const criterionId = requiredString(
      input.criterionId,
      `${label}[${index}].criterionId`,
    );
    if (seen.has(criterionId)) {
      throw new Error(`${label} contains duplicate criterion ${criterionId}`);
    }
    seen.add(criterionId);
    if (
      !REQUIREMENT_KINDS.has(input.verifier as PlanCompletionRequirementKind)
    ) {
      throw new Error(`${label}[${index}].verifier is invalid`);
    }
    return {
      criterionId,
      description: requiredString(
        input.description,
        `${label}[${index}].description`,
      ),
      verifier: input.verifier as PlanCompletionRequirementKind,
    };
  });
}

function decodeProvider(value: unknown, label: string): PlanProvider {
  if (!PROVIDERS.has(value as PlanProvider)) {
    throw new Error(`${label} is invalid`);
  }
  return value as PlanProvider;
}

function decodeRequirements(
  value: unknown,
  label: string,
  typed = false,
): PlanCompletionRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const input = requiredRecord(entry, `${label}[${index}]`);
    const requirementId = requiredString(
      input.requirementId,
      `${label}[${index}].requirementId`,
    );
    if (seen.has(requirementId)) {
      throw new Error(
        `${label} contains duplicate requirement ${requirementId}`,
      );
    }
    seen.add(requirementId);
    if (!REQUIREMENT_KINDS.has(input.kind as PlanCompletionRequirementKind)) {
      throw new Error(`${label}[${index}].kind is invalid`);
    }
    return {
      requirementId,
      kind: input.kind as PlanCompletionRequirementKind,
      criterionIds: typed
        ? stringList(input.criterionIds, `${label}[${index}].criterionIds`)
        : [],
      contractDigest: requiredString(
        input.contractDigest,
        `${label}[${index}].contractDigest`,
      ),
      targetBoundary: isRecord(input.targetBoundary)
        ? {
            targetIds: Array.isArray(input.targetBoundary.targetIds)
              ? stringList(
                  input.targetBoundary.targetIds,
                  `${label}[${index}].targetBoundary.targetIds`,
                )
              : undefined,
            scopeDigest: optionalString(input.targetBoundary.scopeDigest),
            expectedCount:
              input.targetBoundary.expectedCount === undefined
                ? undefined
                : requiredInteger(
                    input.targetBoundary.expectedCount,
                    `${label}[${index}].targetBoundary.expectedCount`,
                    0,
                  ),
          }
        : undefined,
    };
  });
}

export function decodePlanStep(
  value: unknown,
  index: number,
  typed = false,
): PlanStep {
  const input = requiredRecord(value, `steps[${index}]`);
  if (!STEP_EFFECTS.has(input.expectedEffect as PlanStepEffect)) {
    throw new Error(`steps[${index}].expectedEffect is invalid`);
  }
  const target = isRecord(input.targetBoundary)
    ? {
        kind: input.targetBoundary.kind as
          | "collection"
          | "library"
          | "selection"
          | "conversation",
        targetIds: Array.isArray(input.targetBoundary.targetIds)
          ? stringList(
              input.targetBoundary.targetIds,
              `steps[${index}].targetBoundary.targetIds`,
            )
          : undefined,
        scopeDigest: optionalString(input.targetBoundary.scopeDigest),
      }
    : undefined;
  if (
    target &&
    !["collection", "library", "selection", "conversation"].includes(
      target.kind,
    )
  ) {
    throw new Error(`steps[${index}].targetBoundary.kind is invalid`);
  }
  return {
    planStepId: requiredString(input.planStepId, `steps[${index}].planStepId`),
    content: requiredString(input.content, `steps[${index}].content`),
    activeForm: requiredString(input.activeForm, `steps[${index}].activeForm`),
    acceptanceCriteria: decodeAcceptanceCriteria(
      input.acceptanceCriteria,
      `steps[${index}].acceptanceCriteria`,
      typed,
    ),
    expectedCapability: optionalString(input.expectedCapability),
    expectedEffect: input.expectedEffect as PlanStepEffect,
    actionIndexes:
      input.actionIndexes === undefined
        ? undefined
        : (() => {
            if (!isActionIndexList(input.actionIndexes))
              throw new Error("Invalid plan action indexes");
            return input.actionIndexes;
          })(),
    materialOutputId: optionalString(input.materialOutputId),
    completionRequirements: decodeRequirements(
      input.completionRequirements,
      `steps[${index}].completionRequirements`,
      typed,
    ),
    targetBoundary: target,
  };
}

function decodeSkillRoutingReceipt(
  value: unknown,
): PlanSkillRoutingReceipt | undefined {
  if (value === undefined) return undefined;
  const input = requiredRecord(value, "skillRoutingReceipt");
  if (!Array.isArray(input.skills)) {
    throw new Error("skillRoutingReceipt.skills must be an array");
  }
  return {
    routerSchemaVersion: requiredInteger(
      input.routerSchemaVersion,
      "skillRoutingReceipt.routerSchemaVersion",
      1,
    ),
    skillManifestHash: requiredString(
      input.skillManifestHash,
      "skillRoutingReceipt.skillManifestHash",
    ),
    skills: input.skills.map((entry, index) => {
      const skill = requiredRecord(
        entry,
        `skillRoutingReceipt.skills[${index}]`,
      );
      if (skill.source !== "automatic" && skill.source !== "explicit") {
        throw new Error(
          `skillRoutingReceipt.skills[${index}].source is invalid`,
        );
      }
      return {
        id: requiredString(skill.id, `skillRoutingReceipt.skills[${index}].id`),
        version: requiredInteger(
          skill.version,
          `skillRoutingReceipt.skills[${index}].version`,
          1,
        ),
        instructionHash: requiredString(
          skill.instructionHash,
          `skillRoutingReceipt.skills[${index}].instructionHash`,
        ),
        source: skill.source,
      };
    }),
  };
}

export function decodePlanArtifact(value: unknown): PlanArtifact {
  const input = requiredRecord(value, "plan artifact");
  if (
    input.version !== 1 &&
    input.version !== 2 &&
    input.version !== 3 &&
    input.version !== 4
  ) {
    throw new Error("Plan artifact version is unsupported");
  }
  if (!ARTIFACT_STATUSES.has(input.status as PlanArtifactStatus)) {
    throw new Error("Plan artifact status is invalid");
  }
  if (!Array.isArray(input.steps) || !input.steps.length) {
    throw new Error("Plan artifact requires steps");
  }
  const status = input.status as PlanArtifactStatus;
  const contract =
    input.version === 3 || input.version === 4
      ? decodePlanContract(input.contract, {
          requireSnapshot:
            status === "awaiting_approval" || status === "approved",
        })
      : undefined;
  return {
    version: input.version,
    planId: requiredString(input.planId, "plan artifact planId"),
    conversationKey: requiredNumber(
      input.conversationKey,
      "plan artifact conversationKey",
    ),
    provider: decodeProvider(input.provider, "plan artifact provider"),
    revision: requiredNumber(input.revision, "plan artifact revision"),
    digest: requiredString(input.digest, "plan artifact digest"),
    status,
    explanation: optionalString(input.explanation),
    actionContractId: optionalString(input.actionContractId),
    actionContract: isRecord(input.actionContract)
      ? decodeActionContract(input.actionContract)
      : undefined,
    sourceRunId: optionalString(input.sourceRunId),
    ...(input.nativePlanning
      ? { nativePlanning: decodeNativePlanBinding(input.nativePlanning) }
      : {}),
    skillRoutingReceipt: decodeSkillRoutingReceipt(input.skillRoutingReceipt),
    contract,
    contractDigest:
      input.version === 3 || input.version === 4
        ? requiredString(input.contractDigest, "plan artifact contractDigest")
        : optionalString(input.contractDigest),
    steps: input.steps.map((step, index) =>
      decodePlanStep(step, index, input.version === 4),
    ),
    createdAt: requiredNumber(input.createdAt, "plan artifact createdAt"),
    updatedAt: requiredNumber(input.updatedAt, "plan artifact updatedAt"),
    approvedAt:
      input.approvedAt === undefined
        ? undefined
        : requiredNumber(input.approvedAt, "plan artifact approvedAt"),
  };
}

export function decodeExecutionTask(value: unknown): ExecutionTask {
  const input = requiredRecord(value, "execution task");
  if (input.version !== 1 && input.version !== 2)
    throw new Error("Execution task version is unsupported");
  if (!TASK_STATUSES.has(input.status as ExecutionTaskStatus)) {
    throw new Error("Execution task status is invalid");
  }
  if (!STEP_EFFECTS.has(input.expectedEffect as PlanStepEffect)) {
    throw new Error("Execution task expectedEffect is invalid");
  }
  if (input.kind !== "required_step" && input.kind !== "supporting_child") {
    throw new Error("Execution task kind is invalid");
  }
  return {
    version: input.version,
    taskId: requiredString(input.taskId, "execution task taskId"),
    executionId: requiredString(
      input.executionId,
      "execution task executionId",
    ),
    planStepId: requiredString(input.planStepId, "execution task planStepId"),
    parentTaskId: optionalString(input.parentTaskId),
    kind: input.kind,
    content: requiredString(input.content, "execution task content"),
    activeForm: requiredString(input.activeForm, "execution task activeForm"),
    acceptanceCriteria: decodeAcceptanceCriteria(
      input.acceptanceCriteria,
      "execution task acceptanceCriteria",
      input.version === 2,
    ),
    expectedEffect: input.expectedEffect as PlanStepEffect,
    actionIndexes:
      input.actionIndexes === undefined
        ? undefined
        : (() => {
            if (!isActionIndexList(input.actionIndexes))
              throw new Error("Invalid plan action indexes");
            return input.actionIndexes;
          })(),
    materialOutputId: optionalString(input.materialOutputId),
    completionRequirements: decodeRequirements(
      input.completionRequirements,
      "execution task completionRequirements",
      input.version === 2,
    ),
    expectedCapability: optionalString(input.expectedCapability),
    obligationIds: stringList(
      input.obligationIds,
      "execution task obligationIds",
    ),
    status: input.status as ExecutionTaskStatus,
    attemptCount: requiredNumber(
      input.attemptCount,
      "execution task attemptCount",
    ),
    evidenceIds: stringList(input.evidenceIds, "execution task evidenceIds"),
    failureReasons: stringList(
      input.failureReasons,
      "execution task failureReasons",
    ),
    createdAt: requiredNumber(input.createdAt, "execution task createdAt"),
    updatedAt: requiredNumber(input.updatedAt, "execution task updatedAt"),
    startedAt:
      input.startedAt === undefined
        ? undefined
        : requiredNumber(input.startedAt, "execution task startedAt"),
    completedAt:
      input.completedAt === undefined
        ? undefined
        : requiredNumber(input.completedAt, "execution task completedAt"),
  };
}

export function decodePlanExecutionLedger(value: unknown): PlanExecutionLedger {
  const input = requiredRecord(value, "plan execution ledger");
  if (input.version !== 1 && input.version !== 2) {
    throw new Error("Plan execution ledger version is unsupported");
  }
  if (!EXECUTION_STATUSES.has(input.status as PlanExecutionStatus)) {
    throw new Error("Plan execution ledger status is invalid");
  }
  if (!Array.isArray(input.tasks)) {
    throw new Error("Plan execution ledger tasks must be an array");
  }
  const grant = requiredRecord(input.grant, "plan execution grant");
  if (grant.version !== 1) throw new Error("Approved plan grant is invalid");
  return {
    version: input.version,
    executionId: requiredString(input.executionId, "executionId"),
    planId: requiredString(input.planId, "planId"),
    revision: requiredNumber(input.revision, "revision"),
    planDigest: requiredString(input.planDigest, "planDigest"),
    conversationKey: requiredNumber(input.conversationKey, "conversationKey"),
    attempt: requiredNumber(input.attempt, "attempt"),
    provider: decodeProvider(input.provider, "provider"),
    providerContinuationId: optionalString(input.providerContinuationId),
    actionContractId: optionalString(input.actionContractId),
    grant: {
      version: 1,
      planId: requiredString(grant.planId, "grant.planId"),
      revision: requiredNumber(grant.revision, "grant.revision"),
      planDigest: requiredString(grant.planDigest, "grant.planDigest"),
      conversationKey: requiredNumber(
        grant.conversationKey,
        "grant.conversationKey",
      ),
      conversationGeneration: requiredNumber(
        grant.conversationGeneration,
        "grant.conversationGeneration",
      ),
      actionContractId: optionalString(grant.actionContractId),
      authority:
        grant.authority === "auto_policy" || grant.authority === "yolo"
          ? grant.authority
          : "user",
      approvedAt: requiredNumber(grant.approvedAt, "grant.approvedAt"),
    },
    status: input.status as PlanExecutionStatus,
    activeTaskId: optionalString(input.activeTaskId),
    tasks: input.tasks.map(decodeExecutionTask),
    createdAt: requiredNumber(input.createdAt, "createdAt"),
    updatedAt: requiredNumber(input.updatedAt, "updatedAt"),
    completedAt:
      input.completedAt === undefined
        ? undefined
        : requiredNumber(input.completedAt, "completedAt"),
    predecessorExecutionId: optionalString(input.predecessorExecutionId),
    supersededByExecutionId: optionalString(input.supersededByExecutionId),
  };
}

export function decodeTaskEvidence(value: unknown): TaskEvidence {
  const input = requiredRecord(value, "task evidence");
  if (input.version !== 1 && input.version !== 2 && input.version !== 3) {
    throw new Error("Task evidence version is unsupported");
  }
  if (!EVIDENCE_KINDS.has(input.kind as TaskEvidenceKind)) {
    throw new Error("Task evidence kind is invalid");
  }
  let payload: TaskEvidencePayload | undefined;
  if (input.payload !== undefined) {
    const rawPayload = requiredRecord(input.payload, "evidence.payload");
    const type = requiredString(rawPayload.type, "evidence.payload.type");
    if (type === "verified_read") {
      const sources = rawPayload.sources;
      if (sources !== undefined && !Array.isArray(sources)) {
        throw new Error("evidence.payload.sources must be an array");
      }
      const observations = rawPayload.observations;
      if (observations !== undefined && !Array.isArray(observations)) {
        throw new Error("evidence.payload.observations must be an array");
      }
      payload = {
        type,
        reference: requiredString(
          rawPayload.reference,
          "evidence.payload.reference",
        ),
        sources: Array.isArray(sources)
          ? sources.map((entry, index) => {
              const source = requiredRecord(
                entry,
                `evidence.payload.sources[${index}]`,
              );
              return {
                libraryID: requiredInteger(
                  source.libraryID,
                  `evidence.payload.sources[${index}].libraryID`,
                  1,
                ),
                itemKey: requiredString(
                  source.itemKey,
                  `evidence.payload.sources[${index}].itemKey`,
                ),
                attachmentItemKey: optionalString(source.attachmentItemKey),
                pageIndex:
                  source.pageIndex === undefined
                    ? undefined
                    : requiredInteger(
                        source.pageIndex,
                        `evidence.payload.sources[${index}].pageIndex`,
                        0,
                      ),
                sourceFingerprint: optionalString(source.sourceFingerprint),
              };
            })
          : undefined,
        observations: Array.isArray(observations)
          ? observations.map((entry, index) => {
              const observation = requiredRecord(
                entry,
                `evidence.payload.observations[${index}]`,
              );
              if (
                observation.version !== 1 ||
                observation.issuer !== "zotero_host" ||
                !Array.isArray(observation.capabilities)
              ) {
                throw new Error(
                  `evidence.payload.observations[${index}] is invalid`,
                );
              }
              const capabilities = stringList(
                observation.capabilities,
                `evidence.payload.observations[${index}].capabilities`,
              );
              if (
                capabilities.some(
                  (capability) =>
                    ![
                      "metadata",
                      "abstract",
                      "body",
                      "figure",
                      "quote",
                    ].includes(capability),
                )
              ) {
                throw new Error(
                  `evidence.payload.observations[${index}].capabilities is invalid`,
                );
              }
              return {
                version: 1 as const,
                issuer: "zotero_host" as const,
                observationId: requiredString(
                  observation.observationId,
                  `evidence.payload.observations[${index}].observationId`,
                ),
                toolName: requiredString(
                  observation.toolName,
                  `evidence.payload.observations[${index}].toolName`,
                ),
                callDigest: requiredString(
                  observation.callDigest,
                  `evidence.payload.observations[${index}].callDigest`,
                ),
                inputDigest: requiredString(
                  observation.inputDigest,
                  `evidence.payload.observations[${index}].inputDigest`,
                ),
                resultDigest: requiredString(
                  observation.resultDigest,
                  `evidence.payload.observations[${index}].resultDigest`,
                ),
                libraryID: requiredInteger(
                  observation.libraryID,
                  `evidence.payload.observations[${index}].libraryID`,
                  1,
                ),
                itemKey: requiredString(
                  observation.itemKey,
                  `evidence.payload.observations[${index}].itemKey`,
                ),
                capabilities: capabilities as Array<
                  "metadata" | "abstract" | "body" | "figure" | "quote"
                >,
                attachmentItemKey: optionalString(
                  observation.attachmentItemKey,
                ),
                pageIndex:
                  observation.pageIndex === undefined
                    ? undefined
                    : requiredInteger(
                        observation.pageIndex,
                        `evidence.payload.observations[${index}].pageIndex`,
                        0,
                      ),
                sourceFingerprint: optionalString(
                  observation.sourceFingerprint,
                ),
                readMode: optionalString(observation.readMode),
                quoteCertificate: optionalString(observation.quoteCertificate),
                certificateDigest: requiredString(
                  observation.certificateDigest,
                  `evidence.payload.observations[${index}].certificateDigest`,
                ),
              };
            })
          : undefined,
      };
    } else if (type === "research_reading") {
      payload = {
        type,
        researchJobId: requiredString(
          rawPayload.researchJobId,
          "evidence.payload.researchJobId",
        ),
        scopeLineageDigest: requiredString(
          rawPayload.scopeLineageDigest,
          "evidence.payload.scopeLineageDigest",
        ),
        durablePapers: requiredInteger(
          rawPayload.durablePapers,
          "evidence.payload.durablePapers",
          0,
        ),
        totalPapers: requiredInteger(
          rawPayload.totalPapers,
          "evidence.payload.totalPapers",
          0,
        ),
      };
    } else if (type === "bounded_reasoning") {
      payload = {
        type,
        assertion: requiredString(
          rawPayload.assertion,
          "evidence.payload.assertion",
        ),
      };
    } else if (type === "tool_artifacts") {
      if (!Array.isArray(rawPayload.artifacts)) {
        throw new Error("evidence.payload.artifacts must be an array");
      }
      payload = {
        type,
        artifacts: rawPayload.artifacts.map((entry, index) => {
          const artifact = requiredRecord(
            entry,
            `evidence.payload.artifacts[${index}]`,
          );
          if (artifact.kind !== "image" && artifact.kind !== "file_ref") {
            throw new Error(
              `evidence.payload.artifacts[${index}].kind is invalid`,
            );
          }
          return {
            kind: artifact.kind,
            mimeType: requiredString(
              artifact.mimeType,
              `evidence.payload.artifacts[${index}].mimeType`,
            ),
            storedPath: requiredString(
              artifact.storedPath,
              `evidence.payload.artifacts[${index}].storedPath`,
            ),
            contentHash: optionalString(artifact.contentHash),
          };
        }),
      };
    } else if (type === "research_coverage") {
      if (
        ![
          "complete",
          "complete_with_limitations",
          "partial",
          "failed",
        ].includes(String(rawPayload.coverageStatus))
      ) {
        throw new Error("evidence.payload.coverageStatus is invalid");
      }
      payload = {
        type,
        researchJobId: requiredString(
          rawPayload.researchJobId,
          "evidence.payload.researchJobId",
        ),
        coverageStatus: rawPayload.coverageStatus as Extract<
          TaskEvidencePayload,
          { type: "research_coverage" }
        >["coverageStatus"],
        totalItems: requiredNumber(
          rawPayload.totalItems,
          "evidence.payload.totalItems",
        ),
        screenedItems: requiredNumber(
          rawPayload.screenedItems,
          "evidence.payload.screenedItems",
        ),
        candidateItems: requiredNumber(
          rawPayload.candidateItems,
          "evidence.payload.candidateItems",
        ),
        deepReadCompleted: requiredNumber(
          rawPayload.deepReadCompleted,
          "evidence.payload.deepReadCompleted",
        ),
        // The scope lineage is what binds coverage to its requirement; a
        // decoder that drops it makes every bound coverage task uncompletable.
        ...(typeof rawPayload.scopeLineageDigest === "string" &&
        rawPayload.scopeLineageDigest
          ? { scopeLineageDigest: rawPayload.scopeLineageDigest }
          : {}),
      };
    } else if (type === "material_integrity") {
      if (rawPayload.integrityValidated !== true)
        throw new Error("Workflow material integrity is not verified");
      payload = {
        type,
        materialOutputId: requiredString(
          rawPayload.materialOutputId,
          "materialOutputId",
        ),
        documentId: requiredString(rawPayload.documentId, "documentId"),
        contentHash: requiredString(rawPayload.contentHash, "contentHash"),
        integrityValidated: true,
      };
    } else if (type === "document_integrity") {
      if (rawPayload.integrityValidated !== true) {
        throw new Error("document integrity evidence must be validated");
      }
      payload = {
        type,
        documentId: requiredString(
          rawPayload.documentId,
          "evidence.payload.documentId",
        ),
        contentHash: requiredString(
          rawPayload.contentHash,
          "evidence.payload.contentHash",
        ),
        integrityValidated: true,
      };
    } else if (type === "document_published") {
      payload = {
        type,
        documentId: requiredString(
          rawPayload.documentId,
          "evidence.payload.documentId",
        ),
        contentHash: requiredString(
          rawPayload.contentHash,
          "evidence.payload.contentHash",
        ),
        messageTimestamp: requiredNumber(
          rawPayload.messageTimestamp,
          "evidence.payload.messageTimestamp",
        ),
      };
    } else if (type === "mutation_receipts") {
      payload = {
        type,
        receiptIds: stringList(
          rawPayload.receiptIds,
          "evidence.payload.receiptIds",
        ),
      };
    } else if (type === "user_decision") {
      payload = {
        type,
        actionId: requiredString(
          rawPayload.actionId,
          "evidence.payload.actionId",
        ),
        decidedAt: requiredNumber(
          rawPayload.decidedAt,
          "evidence.payload.decidedAt",
        ),
      };
    } else {
      throw new Error("evidence.payload.type is invalid");
    }
  }
  if (
    (input.version === 2 || input.version === 3) &&
    input.requirementId &&
    !payload
  ) {
    throw new Error("Typed completion evidence requires a payload");
  }
  return {
    version: input.version,
    evidenceId: requiredString(input.evidenceId, "evidenceId"),
    executionId: requiredString(input.executionId, "executionId"),
    taskId: requiredString(input.taskId, "taskId"),
    kind: input.kind as TaskEvidenceKind,
    verified: input.verified === true,
    requirementId: optionalString(input.requirementId),
    criterionIds:
      input.version === 3
        ? stringList(input.criterionIds, "evidence.criterionIds")
        : undefined,
    contractDigest: optionalString(input.contractDigest),
    receipt:
      input.receipt === undefined
        ? undefined
        : decodeActionReceipt(input.receipt, "evidence.receipt"),
    payload,
    reference: optionalString(input.reference),
    summary: optionalString(input.summary),
    createdAt: requiredNumber(input.createdAt, "createdAt"),
  };
}

function decodeNativePlanBinding(
  value: unknown,
): import("./types").NativePlanBinding {
  const input = requiredRecord(value, "native plan binding");
  const proposal =
    input.proposal === undefined
      ? undefined
      : requiredRecord(input.proposal, "native proposal");
  if (typeof input.ephemeral !== "boolean")
    throw new Error("Invalid native session persistence");
  return {
    attemptId: requiredString(input.attemptId, "native plan attempt"),
    threadId: requiredString(input.threadId, "native plan thread"),
    turnId: proposal
      ? requiredString(input.turnId, "native plan turn")
      : optionalString(input.turnId),
    ephemeral: input.ephemeral,
    ...(proposal
      ? {
          proposal: {
            itemId: requiredString(proposal.itemId, "native proposal item"),
            markdown: requiredString(
              proposal.markdown,
              "native proposal Markdown",
            ),
          },
        }
      : {}),
  };
}
