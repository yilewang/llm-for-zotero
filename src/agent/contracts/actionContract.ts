import type {
  AgentActionContract,
  AgentActionEvidence,
  AgentActionObligation,
  AgentActionParameters,
  AgentActionProgressLedger,
  AgentActionProposal,
  AgentActionReceipt,
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolEffect,
  AgentToolContext,
} from "../types";
import {
  itemTarget,
  normalizePath,
  prepareActionExecution,
  verifyNoteWriteTarget,
  type ActionContractGateway,
  type PreparedActionExecution,
} from "./actionOperationEvidence";
import {
  listCurrentLibraryTargetIds,
  listScopeTargetIds,
  resolveScope,
} from "./actionScope";
import { canonicalJsonEqual } from "../services/libraryMutation/canonicalJson";
import { mutationPostconditionIsSatisfied } from "../services/libraryMutation/handlerOperations";
import { innermostToolResult, toolResultString } from "./toolResultEnvelope";

export type {
  ActionContractGateway,
  PreparedActionExecution,
} from "./actionOperationEvidence";
export {
  describeLibraryMutationActions,
  extractLibraryMutationOperations,
} from "./actionOperationEvidence";

export type ScopeValidationFailure = {
  message: string;
  expectedCount: number;
  proposedCount: number;
  rejectedTargets: string[];
  missingTargets: string[];
};

function createContractId(request: AgentRuntimeRequest): string {
  return `action-contract:${request.conversationKey}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function receiptKey(receipt: AgentActionReceipt): string {
  return [
    receipt.obligationId || "unmatched",
    receipt.proposalId,
    receipt.evidenceRef || receipt.id,
  ].join("|");
}

function sameArrayValues(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  const normalize = (values: readonly unknown[]) =>
    [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function parametersMatch(
  expected: AgentActionParameters | undefined,
  actual: AgentActionParameters | undefined,
): boolean {
  if (!expected) return true;
  const actualValue = actual || {};
  return Object.entries(expected).every(([key, value]) => {
    if (value === undefined) return true;
    const proposed = actualValue[key as keyof AgentActionParameters];
    return Array.isArray(value)
      ? Array.isArray(proposed) && sameArrayValues(value, proposed)
      : proposed === value;
  });
}

function matchingObligations(
  contract: AgentActionContract,
  proposal: AgentActionProposal,
): AgentActionObligation[] {
  return contract.obligations.filter(
    (obligation) =>
      obligation.operation === proposal.operation &&
      obligation.proofDomain === proposal.proofDomain &&
      parametersMatch(obligation.parameters, proposal.parameters),
  );
}

function obligationStatus(
  progress: AgentActionProgressLedger | undefined,
  obligationId: string,
) {
  return progress?.obligations.find(
    (entry) => entry.obligationId === obligationId,
  )?.status;
}

function obligationIsUnresolved(
  progress: AgentActionProgressLedger | undefined,
  obligationId: string,
): boolean {
  const status = obligationStatus(progress, obligationId);
  return (
    status !== "fulfilled" &&
    status !== "already_satisfied" &&
    status !== "cancelled"
  );
}

function unresolvedBoundaryItemIds(
  obligation: AgentActionObligation,
  progress: AgentActionProgressLedger | undefined,
): number[] {
  if (!obligation.targetBoundary) return [];
  const entry = progress?.obligations.find(
    (candidate) => candidate.obligationId === obligation.id,
  );
  if (!entry) return obligation.targetBoundary.frozenTargetIds;
  if (!obligationIsUnresolved(progress, obligation.id)) return [];
  return entry.unresolvedTargetIds
    .map((target) => Number(target.match(/^item:(\d+)$/)?.[1]))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0);
}

function isSourceCollectionItemObligation(
  obligation: AgentActionObligation,
): boolean {
  return Boolean(
    obligation.scopeRole !== "destination" &&
    obligation.scope &&
    obligation.targetBoundary?.kind === "collection",
  );
}

function proposalItemTargets(proposal: AgentActionProposal): string[] {
  return proposal.requestedTargets.filter((target) =>
    /^item:\d+$/.test(target),
  );
}

function proposalSatisfiesConstraints(
  obligation: AgentActionObligation,
  proposal: AgentActionProposal,
): boolean {
  const prefix = obligation.constraints?.tagPrefix;
  if (
    prefix &&
    (proposal.parameters?.tags || []).some((tag) => !tag.startsWith(prefix))
  ) {
    return false;
  }
  if (
    obligation.constraints?.collectionMode === "move" &&
    proposal.parameters?.sourceCollectionId === undefined
  ) {
    return false;
  }
  return true;
}

function assignedSourceCollectionObligations(
  contract: AgentActionContract,
  proposal: AgentActionProposal,
  progress?: AgentActionProgressLedger,
): AgentActionObligation[] {
  const requested = new Set(proposalItemTargets(proposal));
  return matchingObligations(contract, proposal).filter(
    (obligation) =>
      isSourceCollectionItemObligation(obligation) &&
      obligationIsUnresolved(progress, obligation.id) &&
      proposalSatisfiesConstraints(obligation, proposal) &&
      unresolvedBoundaryItemIds(obligation, progress).some((itemId) =>
        requested.has(itemTarget(itemId)),
      ),
  );
}

function narrowReceiptToBoundary(
  receipt: AgentActionReceipt,
  obligation: AgentActionObligation,
): AgentActionReceipt {
  if (!obligation.targetBoundary) return receipt;
  const allowed = new Set(
    obligation.targetBoundary.frozenTargetIds.map(itemTarget),
  );
  const narrow = (targets: string[]) =>
    targets.filter((target) => allowed.has(target));
  return {
    ...receipt,
    requestedTargets: narrow(receipt.requestedTargets),
    appliedTargets: narrow(receipt.appliedTargets),
    alreadySatisfiedTargets: narrow(receipt.alreadySatisfiedTargets),
    rejectedTargets: narrow(receipt.rejectedTargets),
  };
}

function failure(
  message: string,
  contract: AgentActionContract,
  prepared: PreparedActionExecution,
  rejectedTargets: string[] = prepared.requestedTargets,
  missingTargets: string[] = contract.obligations.map(
    (obligation) => obligation.operation,
  ),
): ScopeValidationFailure {
  return {
    message,
    expectedCount: contract.obligations.length,
    proposedCount: prepared.proposals.length,
    rejectedTargets,
    missingTargets,
  };
}

function readEvidenceRef(content: unknown): string | undefined {
  return toolResultString(content, ["actionId", "journalStepId"]);
}

function evidenceTargets(evidence: AgentActionEvidence): string[] {
  return [
    ...(evidence.postState.items || []).map((item) => `item:${item.itemId}`),
    ...(evidence.postState.collections || []).map(
      (collection) => `collection:${collection.collectionId}`,
    ),
    ...(evidence.postState.savedSearches || []).map(
      (search) => `saved-search:${search.savedSearchId}`,
    ),
  ];
}

function matchingNativeEvidence(
  proposal: AgentActionProposal,
  evidence: AgentActionEvidence[] | undefined,
): AgentActionEvidence | undefined {
  return evidence?.find(
    (entry) =>
      entry.proofDomain === "zotero_state" &&
      proposal.operationValue !== undefined &&
      canonicalJsonEqual(entry.operationValue, proposal.operationValue),
  );
}

function fileEvidence(
  proposal: AgentActionProposal,
  content: unknown,
): {
  verified: boolean;
  target: string;
  evidenceRef?: string;
  reason?: string;
} {
  const record = innermostToolResult(content);
  const filePath = String(
    record.filePath || proposal.parameters?.filePath || "",
  );
  const actualHash =
    typeof record.contentHash === "string" ? record.contentHash : "";
  const expectedHash =
    proposal.expectedContentHash ||
    proposal.parameters?.contentHash ||
    (typeof record.expectedContentHash === "string"
      ? record.expectedContentHash
      : "");
  const target = filePath ? `file:${filePath}` : "file:unknown";
  if (!filePath || record.exists !== true || !actualHash) {
    return {
      verified: false,
      target,
      reason:
        "The written file was not read back with an exact path and content hash.",
    };
  }
  if (expectedHash && actualHash !== expectedHash) {
    return {
      verified: false,
      target,
      reason: `File readback hash ${actualHash} did not match ${expectedHash}.`,
    };
  }
  return { verified: true, target, evidenceRef: `sha256:${actualHash}` };
}

export class ActionContractService {
  constructor(private readonly gateway: ActionContractGateway) {}

  async createContract(
    request: AgentRuntimeRequest,
  ): Promise<AgentActionContract> {
    const intents = request.classifiedIntent?.actionIntents || [];
    const writeDisposition =
      request.classifiedIntent?.writeDisposition ||
      (intents.length ? "required" : "none");
    if (writeDisposition === "required" && !intents.length) {
      throw new Error(
        "Action contract construction failed: write intent had no valid typed obligations.",
      );
    }
    if (
      writeDisposition === "none" &&
      intents.some((intent) => intent.operation !== "read_full")
    ) {
      throw new Error(
        "Action contract construction failed: no-write intent contained mutation obligations.",
      );
    }
    const contractId = createContractId(request);
    const resolved: AgentActionObligation[] = [];
    for (const intent of intents) {
      resolved.push(...(await resolveScope(this.gateway, request, intent)));
    }
    return {
      version: 2,
      id: contractId,
      writeDisposition,
      interpretationSource:
        request.classifiedIntent?.actionInterpretationSource ||
        "deterministic_fallback",
      obligations: resolved.map((obligation, index) => ({
        ...obligation,
        id: `${contractId}:obligation:${index}`,
      })),
    };
  }

  createProgress(contract: AgentActionContract): AgentActionProgressLedger {
    return {
      version: 1,
      contractId: contract.id,
      state: "pending",
      correctionCount: 0,
      obligations: contract.obligations.map((obligation) => ({
        obligationId: obligation.id,
        status: "open",
        verifiedTargetIds: [],
        unresolvedTargetIds:
          obligation.targetBoundary && obligation.scopeRole !== "destination"
            ? obligation.targetBoundary.frozenTargetIds.map(itemTarget)
            : [],
        journalStepIds: [],
        failureReasons: [],
      })),
      appliedReceiptKeys: [],
      updatedAt: Date.now(),
    };
  }

  applyReceipts(
    progress: AgentActionProgressLedger,
    receipts: AgentActionReceipt[],
  ): void {
    for (const receipt of receipts) {
      const obligation = progress.obligations.find(
        (entry) => entry.obligationId === receipt.obligationId,
      );
      if (!obligation) continue;
      if (
        obligation.status === "cancelled" ||
        obligation.status === "fulfilled" ||
        obligation.status === "already_satisfied"
      ) {
        continue;
      }
      const key = receiptKey(receipt);
      if (progress.appliedReceiptKeys.includes(key)) continue;
      progress.appliedReceiptKeys.push(key);
      const verifiedTargets = [
        ...receipt.appliedTargets,
        ...receipt.alreadySatisfiedTargets,
      ];
      obligation.verifiedTargetIds = [
        ...new Set([...obligation.verifiedTargetIds, ...verifiedTargets]),
      ];
      obligation.unresolvedTargetIds = obligation.unresolvedTargetIds.filter(
        (target) => !verifiedTargets.includes(target),
      );
      if (receipt.evidenceRef) {
        obligation.journalStepIds = [
          ...new Set([...obligation.journalStepIds, receipt.evidenceRef]),
        ];
      }
      obligation.failureReasons = [
        ...new Set([...obligation.failureReasons, ...receipt.reasons]),
      ];
      if (receipt.status === "cancelled") {
        obligation.status = "cancelled";
      } else if (receipt.status === "failed") {
        obligation.status = "failed";
      } else if (
        receipt.status === "applied" ||
        receipt.status === "already_satisfied" ||
        receipt.status === "observed"
      ) {
        obligation.status = obligation.unresolvedTargetIds.length
          ? "partially_fulfilled"
          : receipt.status === "already_satisfied"
            ? "already_satisfied"
            : "fulfilled";
      } else if (verifiedTargets.length) {
        obligation.status = "partially_fulfilled";
      }
    }
    progress.updatedAt = Date.now();
  }

  async prepare(
    tool: AgentToolDefinition<any, any>,
    input: unknown,
    context?: AgentToolContext,
  ): Promise<PreparedActionExecution> {
    return await prepareActionExecution(tool, input, this.gateway, context);
  }

  async validateScope(
    contract: AgentActionContract | undefined,
    prepared: PreparedActionExecution,
    options: {
      allowPartialCoverage?: boolean;
      concreteWrite?: boolean;
      progress?: AgentActionProgressLedger;
    } = {},
  ): Promise<ScopeValidationFailure | null> {
    if (!contract) return null;
    if (
      prepared.mutability === "write" &&
      !prepared.proposals.length &&
      (!prepared.hasExplicitAdapter || options.concreteWrite)
    ) {
      return failure(
        "Write-capable invocation rejected: the tool did not produce a typed action proposal.",
        contract,
        prepared,
      );
    }
    if (!prepared.proposals.length) return null;
    const hasWriteProposal = prepared.proposals.some(
      (proposal) => proposal.operation !== "read_full",
    );
    if (hasWriteProposal && contract.writeDisposition !== "required") {
      return failure(
        contract.writeDisposition === "uncertain"
          ? "Write blocked because the user intent is uncertain and requires clarification."
          : "Write blocked because this request authorizes no mutations.",
        contract,
        prepared,
      );
    }
    if (!contract.obligations.length) {
      return failure(
        "Write blocked because the required-write contract contains no valid obligations.",
        contract,
        prepared,
      );
    }

    for (const proposal of prepared.proposals) {
      const matches = matchingObligations(contract, proposal);
      if (!matches.length) {
        return failure(
          `Action ${proposal.operation} in ${proposal.proofDomain} does not match any authorized obligation.`,
          contract,
          prepared,
          proposal.requestedTargets.length
            ? proposal.requestedTargets
            : [proposal.operation],
        );
      }
      const openMatches = matches.filter((obligation) =>
        obligationIsUnresolved(options.progress, obligation.id),
      );
      if (!openMatches.length) {
        const cancelled = matches.some(
          (obligation) =>
            options.progress?.obligations.find(
              (entry) => entry.obligationId === obligation.id,
            )?.status === "cancelled",
        );
        return failure(
          cancelled
            ? `Action ${proposal.operation} was cancelled and cannot be retried without a new user request.`
            : `Action ${proposal.operation} is already verified and cannot be executed again.`,
          contract,
          prepared,
          proposal.requestedTargets,
          [],
        );
      }
      for (const obligation of openMatches) {
        if (isSourceCollectionItemObligation(obligation)) continue;
        const prefix = obligation.constraints?.tagPrefix;
        const tags = proposal.parameters?.tags || [];
        if (prefix && tags.some((tag) => !tag.startsWith(prefix))) {
          return failure(
            `Action constraint rejected: every tag must start with "${prefix}".`,
            contract,
            prepared,
            tags
              .filter((tag) => !tag.startsWith(prefix))
              .map((tag) => `tag:${tag}`),
            [],
          );
        }
      }
      const sourceCollectionMatches = openMatches.filter(
        isSourceCollectionItemObligation,
      );
      const assignedSourceCollections = assignedSourceCollectionObligations(
        contract,
        proposal,
        options.progress,
      );
      if (sourceCollectionMatches.length) {
        const requestedItems = proposalItemTargets(proposal);
        if (!requestedItems.length || !assignedSourceCollections.length) {
          return failure(
            "Action scope rejected: proposed targets do not intersect an unresolved source-collection boundary.",
            contract,
            prepared,
            requestedItems,
            [],
          );
        }
        const libraries = new Set(
          assignedSourceCollections.map(
            (obligation) => obligation.targetBoundary!.libraryID,
          ),
        );
        if (libraries.size !== 1) {
          return failure(
            "Action scope rejected: source-collection boundaries belong to different Zotero libraries.",
            contract,
            prepared,
            requestedItems,
            [],
          );
        }
        const authorizedUnion = new Set(
          assignedSourceCollections.flatMap((obligation) =>
            unresolvedBoundaryItemIds(obligation, options.progress).map(
              itemTarget,
            ),
          ),
        );
        const rejected = requestedItems.filter(
          (target) => !authorizedUnion.has(target),
        );
        if (rejected.length) {
          return failure(
            "Action scope rejected: proposed targets fall outside the assigned source-collection union.",
            contract,
            prepared,
            rejected,
            [],
          );
        }
        for (const obligation of assignedSourceCollections) {
          const scope = obligation.scope!;
          const boundary = obligation.targetBoundary!;
          const currentTargets = await listScopeTargetIds(this.gateway, {
            libraryID: scope.libraryID,
            collectionId: scope.collectionId,
            collectionPath: scope.collectionPath,
            targetKind: obligation.targetKind,
            includeDescendants: scope.includeDescendants,
          });
          if (
            !sameArrayValues(
              currentTargets.map(String),
              boundary.frozenTargetIds.map(String),
            )
          ) {
            return failure(
              "Frozen target scope changed after planning; refresh and retry before mutating.",
              contract,
              prepared,
              [],
              boundary.frozenTargetIds.map(itemTarget),
            );
          }
        }
      }
      for (const obligation of openMatches.filter(
        (entry) => !isSourceCollectionItemObligation(entry),
      )) {
        if (!obligation.targetBoundary) continue;
        const scope = obligation.scope;
        const boundary = obligation.targetBoundary;
        const currentTargets =
          boundary.kind === "collection" && scope
            ? await listScopeTargetIds(this.gateway, {
                libraryID: scope.libraryID,
                collectionId: scope.collectionId,
                collectionPath: scope.collectionPath,
                targetKind: obligation.targetKind,
                includeDescendants: scope.includeDescendants,
              })
            : boundary.kind === "library"
              ? await listCurrentLibraryTargetIds(this.gateway, {
                  libraryID: boundary.libraryID,
                  targetKind: obligation.targetKind,
                })
              : boundary.frozenTargetIds.filter((itemId) =>
                  Boolean(this.gateway.getItem(itemId)),
                );
        if (
          !sameArrayValues(
            currentTargets.map(String),
            boundary.frozenTargetIds.map(String),
          )
        ) {
          return failure(
            "Frozen target scope changed after planning; refresh and retry before mutating.",
            contract,
            prepared,
            [],
            boundary.frozenTargetIds.map(itemTarget),
          );
        }
        if (obligation.scopeRole === "destination" && scope) {
          if (!proposal.destinationCollectionIds.includes(scope.collectionId)) {
            return failure(
              `Action destination must be exact collection ${scope.collectionId}.`,
              contract,
              prepared,
              proposal.destinationCollectionIds.map((id) => `collection:${id}`),
              [`collection:${scope.collectionId}`],
            );
          }
          continue;
        }
        const expected = new Set(boundary.frozenTargetIds.map(itemTarget));
        const rejected = proposal.requestedTargets.filter(
          (target) => target.startsWith("item:") && !expected.has(target),
        );
        if (rejected.length) {
          return failure(
            "Action scope rejected: proposed targets fall outside the frozen boundary.",
            contract,
            prepared,
            rejected,
            [],
          );
        }
      }
    }

    for (const obligation of contract.obligations) {
      const progressStatus = options.progress?.obligations.find(
        (entry) => entry.obligationId === obligation.id,
      )?.status;
      if (
        progressStatus === "fulfilled" ||
        progressStatus === "already_satisfied" ||
        progressStatus === "cancelled" ||
        !obligation.targetBoundary ||
        obligation.scopeRole === "destination" ||
        options.allowPartialCoverage
      ) {
        continue;
      }
      const proposed = new Set(
        prepared.proposals
          .filter((proposal) => {
            if (!isSourceCollectionItemObligation(obligation)) {
              return matchingObligations(contract, proposal).includes(
                obligation,
              );
            }
            return assignedSourceCollectionObligations(
              contract,
              proposal,
              options.progress,
            ).includes(obligation);
          })
          .flatMap((proposal) => proposal.requestedTargets),
      );
      const missing = unresolvedBoundaryItemIds(obligation, options.progress)
        .map(itemTarget)
        .filter((target) => !proposed.has(target));
      if (missing.length) {
        return failure(
          "Action coverage rejected: every frozen target must be authorized before the batch starts.",
          contract,
          prepared,
          [],
          missing,
        );
      }
    }
    return null;
  }

  finalize(
    contract: AgentActionContract | undefined,
    prepared: PreparedActionExecution,
    params: {
      ok: boolean;
      effect?: AgentToolEffect;
      cancelled?: boolean;
      reason?: string;
      content?: unknown;
      actionEvidence?: AgentActionEvidence[];
    },
    progress?: AgentActionProgressLedger,
  ): AgentActionReceipt[] {
    return prepared.proposals.flatMap((proposal) => {
      let obligations: Array<AgentActionObligation | undefined>;
      if (!contract) {
        obligations = [undefined];
      } else {
        const matches = matchingObligations(contract, proposal);
        const hasSourceCollectionMatch = matches.some(
          isSourceCollectionItemObligation,
        );
        obligations = hasSourceCollectionMatch
          ? [
              ...assignedSourceCollectionObligations(
                contract,
                proposal,
                progress,
              ),
              ...matches.filter(
                (obligation) =>
                  !isSourceCollectionItemObligation(obligation) &&
                  obligationIsUnresolved(progress, obligation.id),
              ),
            ]
          : matches;
      }
      return (obligations.length ? obligations : [undefined]).map(
        (obligation) => {
          const receipt = this.finalizeProposal(proposal, obligation, params);
          return obligation && isSourceCollectionItemObligation(obligation)
            ? narrowReceiptToBoundary(receipt, obligation)
            : receipt;
        },
      );
    });
  }

  private finalizeProposal(
    proposal: AgentActionProposal,
    obligation: AgentActionObligation | undefined,
    params: {
      ok: boolean;
      effect?: AgentToolEffect;
      cancelled?: boolean;
      reason?: string;
      content?: unknown;
      actionEvidence?: AgentActionEvidence[];
    },
  ): AgentActionReceipt {
    const evidenceRef = readEvidenceRef(params.content);
    const base = {
      version: 2 as const,
      id: `${proposal.id}:${obligation?.id || "unmatched"}:${evidenceRef || "result"}`,
      obligationId: obligation?.id,
      proposalId: proposal.id,
      proofDomain: proposal.proofDomain,
      capability: proposal.capability,
      operation: proposal.operation,
      requestedTargets: proposal.requestedTargets,
      rejectedTargets: [] as string[],
      normalizedParameters: proposal.parameters,
      reasons: params.reason ? [params.reason] : [],
      verifiedFacts:
        proposal.operation === "read_full" ? ["read_mode:full"] : [],
      evidenceRef,
    };
    if (params.cancelled) {
      return {
        ...base,
        verification: "not_applicable",
        status: "cancelled",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (!params.ok) {
      return {
        ...base,
        verification: "unverified",
        status: "failed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (proposal.proofDomain === "execution") {
      return {
        ...base,
        verification: "execution_only",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (proposal.proofDomain === "file_state") {
      const proof = fileEvidence(proposal, params.content);
      return {
        ...base,
        id: `${base.id}:${proof.evidenceRef || "unverified"}`,
        evidenceRef: proof.evidenceRef,
        verification: proof.verified ? "verified" : "unverified",
        status: proof.verified
          ? params.effect === "none"
            ? "already_satisfied"
            : "applied"
          : "unverified",
        requestedTargets: [proof.target],
        appliedTargets:
          proof.verified && params.effect !== "none" ? [proof.target] : [],
        alreadySatisfiedTargets:
          proof.verified && params.effect === "none" ? [proof.target] : [],
        reasons: [...base.reasons, ...(proof.reason ? [proof.reason] : [])],
      };
    }
    if (proposal.operation === "read_full") {
      return {
        ...base,
        verification: "verified",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (
      proposal.operation === "note_create" ||
      proposal.operation === "note_edit" ||
      proposal.operation === "note_append"
    ) {
      const verification = verifyNoteWriteTarget(
        proposal,
        params.content,
        this.gateway,
      );
      return verification.targets
        ? {
            ...base,
            verification: "verified",
            status: params.effect === "none" ? "already_satisfied" : "applied",
            requestedTargets: verification.targets,
            appliedTargets:
              params.effect === "none" ? [] : verification.targets,
            alreadySatisfiedTargets:
              params.effect === "none" ? verification.targets : [],
          }
        : {
            ...base,
            verification: "unverified",
            status: "unverified",
            appliedTargets: [],
            alreadySatisfiedTargets: [],
            reasons: [...base.reasons, verification.reason],
          };
    }

    if (proposal.operation === "settings_update") {
      const key = proposal.parameters?.settingsKey || "";
      const state = key ? this.gateway.getSettingNativeState?.(key) : undefined;
      const verified = Boolean(
        state?.exists &&
        JSON.stringify(state.value) === proposal.parameters?.settingsValue,
      );
      const target = `setting:${key || "unknown"}`;
      return {
        ...base,
        verification: verified ? "verified" : "unverified",
        status: verified
          ? params.effect === "none"
            ? "already_satisfied"
            : "applied"
          : "unverified",
        requestedTargets: [target],
        appliedTargets: verified && params.effect !== "none" ? [target] : [],
        alreadySatisfiedTargets:
          verified && params.effect === "none" ? [target] : [],
        rejectedTargets: verified ? [] : [target],
      };
    }
    if (proposal.operation === "annotation_write") {
      const result = innermostToolResult(params.content);
      const annotationId = Number(result.annotationId);
      const annotation = annotationId
        ? this.gateway.getItem(annotationId)
        : null;
      const verified = Boolean(
        annotation &&
        annotation.isAnnotation?.() === true &&
        Number(annotation.parentID) === proposal.parameters?.targetItemId,
      );
      const target = annotationId
        ? `item:${annotationId}`
        : proposal.requestedTargets[0] || "annotation:unknown";
      return {
        ...base,
        verification: verified ? "verified" : "unverified",
        status: verified ? "applied" : "unverified",
        requestedTargets: [target],
        appliedTargets: verified ? [target] : [],
        alreadySatisfiedTargets: [],
        rejectedTargets: verified ? [] : [target],
      };
    }
    if (proposal.operation === "undo" || proposal.operation === "revert") {
      const result = innermostToolResult(params.content);
      const noWork =
        result.status === "nothing_reversible" ||
        (Number(result.reverted) === 0 &&
          Number(result.partiallyReverted) === 0 &&
          params.effect === "none");
      const verified =
        noWork ||
        (proposal.operation === "undo"
          ? result.status === "undone"
          : Number(result.reverted) > 0 &&
            Number(result.partiallyReverted) === 0 &&
            Array.isArray(result.actionIds));
      return {
        ...base,
        verification: verified ? "verified" : "unverified",
        status: verified
          ? noWork
            ? "already_satisfied"
            : "applied"
          : "unverified",
        appliedTargets: verified && !noWork ? proposal.requestedTargets : [],
        alreadySatisfiedTargets:
          verified && noWork ? proposal.requestedTargets : [],
        rejectedTargets: verified ? [] : proposal.requestedTargets,
        evidenceRef:
          proposal.operation === "undo" && typeof result.actionId === "string"
            ? result.actionId
            : base.evidenceRef,
      };
    }

    const operation = proposal.operationValue;
    if (!operation) {
      return {
        ...base,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        reasons: [
          ...base.reasons,
          "No native Zotero post-state verifier is registered for this action.",
        ],
      };
    }
    const evidence = matchingNativeEvidence(proposal, params.actionEvidence);
    const verified = Boolean(
      evidence &&
      mutationPostconditionIsSatisfied(operation, evidence.postState),
    );
    const targets = proposal.requestedTargets.length
      ? proposal.requestedTargets
      : evidence
        ? evidenceTargets(evidence)
        : [];
    const wasAlreadySatisfied = Boolean(
      evidence &&
      mutationPostconditionIsSatisfied(operation, evidence.preState),
    );
    const alreadySatisfied =
      verified && (wasAlreadySatisfied || params.effect === "none");
    return {
      ...base,
      evidenceRef: evidence?.journalStepId || base.evidenceRef,
      verification: verified ? "verified" : "unverified",
      status: verified
        ? alreadySatisfied
          ? "already_satisfied"
          : "applied"
        : "unverified",
      requestedTargets: targets,
      appliedTargets: verified && !alreadySatisfied ? targets : [],
      alreadySatisfiedTargets: alreadySatisfied ? targets : [],
      rejectedTargets: verified ? [] : targets,
      reasons: [
        ...base.reasons,
        ...(verified
          ? []
          : [
              evidence
                ? `The mutation handler rejected the captured native post-state for ${operation.type}.`
                : `No captured native post-state was attached for ${operation.type}.`,
            ]),
      ],
    };
  }

  rejectionReceipts(
    contract: AgentActionContract | undefined,
    prepared: PreparedActionExecution,
    validationFailure: ScopeValidationFailure,
  ): AgentActionReceipt[] {
    const proposals = prepared.proposals.length
      ? prepared.proposals
      : [
          {
            id: "missing-proposal",
            proofDomain: "zotero_state" as const,
            capability: "zotero.read" as const,
            operation: "read_full" as const,
            source: "full_read" as const,
            requestedTargets: [] as string[],
            destinationCollectionIds: [] as number[],
          },
        ];
    return proposals.map((proposal) => ({
      version: 2,
      id: `${proposal.id}:rejected`,
      proposalId: proposal.id,
      proofDomain: proposal.proofDomain,
      capability: proposal.capability,
      operation: proposal.operation,
      verification: "not_applicable",
      status: "failed",
      requestedTargets: proposal.requestedTargets,
      appliedTargets: [],
      alreadySatisfiedTargets: [],
      rejectedTargets: validationFailure.rejectedTargets,
      normalizedParameters: proposal.parameters,
      reasons: [validationFailure.message],
      verifiedFacts: [],
      obligationId: contract
        ? matchingObligations(contract, proposal)[0]?.id
        : undefined,
    }));
  }
}
