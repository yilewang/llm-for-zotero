import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  loadPlanArtifact,
  loadPlanExecutionLedger,
  loadPlanAmendmentGrantByProposalDigest,
  savePlanExecutionLedger,
  savePlanAmendmentProposal,
  savePlanAmendmentGrant,
  updatePlanAmendmentProposalStatus,
  updatePlanAmendmentGrant,
} from "./store";
import type { ScopeValidationFailure } from "../contracts/actionContract";
import type { AgentActionContract } from "../contracts/types";
import type { ActionProposal } from "../authorization/types";
import type { PlanRuntimeContext } from "./types";
import type { PlanExecutionLedger, PlanProvider, TaskEvidence } from "./types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  appendResearchCorpusItem,
  invalidateLatestResearchMutationApprovalGrant,
  invalidateResearchGraph,
  listScopeSnapshotItems,
  listResearchCorpusItems,
  listResearchEvidence,
  listPaperFindings,
  listResearchWorkItems,
  loadResearchJobForExecution,
  loadScopeSnapshotRef,
  saveResearchJob,
  saveResearchCorpusItem,
  saveResearchEvidence,
  savePaperFinding,
  saveResearchWorkItem,
  saveScopeSnapshot,
} from "../research/store";
import { buildResearchScopeSuccessorSnapshot } from "../research/scopeSnapshot";
import {
  assertTaskCompletionEvidence,
  planExecutionCoordinator,
} from "./coordinator";
import type { ResearchJob } from "../research/types";
import { listExecutionTaskEvidence, saveTaskEvidence } from "./store";
import type {
  PlanAmendmentAuthority,
  PlanAmendmentGoalImpact,
  PlanAmendmentGrant,
  PlanAmendmentProposal,
} from "./planAmendmentTypes";

export type PlanAmendmentDecision =
  | Readonly<{ kind: "execute"; authority: PlanAmendmentAuthority }>
  | Readonly<{ kind: "confirm"; authority: "user" }>
  | Readonly<{ kind: "review"; authority: "user" }>
  | Readonly<{ kind: "block"; reason: string }>;

/** Scope-failure decisions include the yolo judgment grant, which has no plan ledger. */
export type ActionScopeDecision =
  | PlanAmendmentDecision
  | Readonly<{ kind: "execute"; authority: "yolo_judgment" }>;

const JUDGMENT_AMENDABLE_CODES: ReadonlySet<ScopeValidationFailure["code"]> =
  new Set([
    "different_operation",
    "different_parameters",
    "scope_mismatch",
    "fixed_selection",
    "added_target",
    "incomplete_batch",
  ]);

const RAIL_RISK_SIGNALS: ReadonlySet<string> = new Set([
  "protected_target",
  "authorization_tampering",
  "privilege_escalation",
]);

export function classifyPlanAmendmentAuthority(params: {
  mode: OriginalAgentPermissionMode;
  goalImpact: PlanAmendmentGoalImpact;
  hardBlocked: boolean;
}): PlanAmendmentDecision {
  if (params.hardBlocked) {
    return {
      kind: "block",
      reason:
        "The amendment violates a hard scope, lifecycle, or integrity boundary.",
    };
  }
  if (params.goalImpact === "contract_revision") {
    return params.mode === "yolo"
      ? { kind: "execute", authority: "yolo" }
      : { kind: "review", authority: "user" };
  }
  if (params.mode === "safe") {
    return { kind: "confirm", authority: "user" };
  }
  return {
    kind: "execute",
    authority: params.mode === "yolo" ? "yolo" : "auto_policy",
  };
}

export function classifyPlanAmendmentAuthorityForProvider(params: {
  provider: PlanProvider;
  originalMode: OriginalAgentPermissionMode;
  goalImpact: PlanAmendmentGoalImpact;
  hardBlocked: boolean;
}): PlanAmendmentDecision {
  if (params.provider === "original") {
    return classifyPlanAmendmentAuthority({
      mode: params.originalMode,
      goalImpact: params.goalImpact,
      hardBlocked: params.hardBlocked,
    });
  }
  if (params.hardBlocked) {
    return classifyPlanAmendmentAuthority({
      mode: "safe",
      goalImpact: params.goalImpact,
      hardBlocked: true,
    });
  }
  return params.goalImpact === "contract_revision"
    ? { kind: "review", authority: "user" }
    : { kind: "execute", authority: "user" };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export class PlanAmendmentService {
  constructor(private readonly gateway?: ZoteroGateway) {}

  decideAuthority(params: {
    provider: PlanProvider;
    originalMode: OriginalAgentPermissionMode;
    goalImpact: PlanAmendmentGoalImpact;
    hardBlocked: boolean;
  }): PlanAmendmentDecision {
    return classifyPlanAmendmentAuthorityForProvider(params);
  }

  decideActionScopeAmendment(params: {
    planContext?: PlanRuntimeContext;
    originalMode: OriginalAgentPermissionMode;
    failure: ScopeValidationFailure;
    actionImpact: "read_only" | "state_change" | "ambiguous" | "prohibited";
    riskSignals: readonly string[];
    hasHardConstraints: boolean;
  }): ActionScopeDecision {
    const plan = params.planContext;
    const details = params.failure.amendableObligation;
    const railSignal = params.riskSignals.some((signal) =>
      RAIL_RISK_SIGNALS.has(signal),
    );
    const hardBlocked =
      params.actionImpact === "prohibited" ||
      params.hasHardConstraints ||
      railSignal;
    const planAmendable = Boolean(
      plan &&
      plan.phase === "executing" &&
      params.failure.code === "added_target" &&
      details &&
      details.addedTargetIds.length &&
      details.boundaryKind !== undefined,
    );
    if (planAmendable) {
      return this.decideAuthority({
        provider: plan!.provider,
        originalMode: params.originalMode,
        goalImpact: "within_goal",
        hardBlocked,
      });
    }
    // Yolo judgment: the user delegated decisions. Violating proposals were
    // already blocked by authorizeOriginalAction; here only the impact and
    // integrity signals remain as rails.
    if (
      params.originalMode === "yolo" &&
      params.actionImpact !== "prohibited" &&
      !railSignal &&
      JUDGMENT_AMENDABLE_CODES.has(params.failure.code)
    ) {
      return { kind: "execute", authority: "yolo_judgment" };
    }
    return {
      kind: "block",
      reason:
        "Only a host-validated addition inside an approved source can amend an executing Plan.",
    };
  }

  async digest(value: unknown): Promise<string> {
    return `sha256:${await sha256Text(canonicalJson(value))}`;
  }

  async executionIdentityDigest(ledger: PlanExecutionLedger): Promise<string> {
    return this.digest({
      executionId: ledger.executionId,
      planId: ledger.planId,
      revision: ledger.revision,
      planDigest: ledger.planDigest,
      conversationKey: ledger.conversationKey,
      grant: ledger.grant,
    });
  }

  assertContractRevisionHardBoundaries(params: {
    priorActionContract?: AgentActionContract;
    replacementActionContract?: AgentActionContract;
    replacementHasEffects: boolean;
  }): void {
    const constraints = params.priorActionContract?.hardConstraints || [];
    if (!params.replacementHasEffects || !constraints.length) return;
    if (constraints.some((constraint) => constraint.kind === "no_write")) {
      throw new Error(
        "The successor Plan cannot add effects because the approved execution has an explicit no-write prohibition.",
      );
    }
    const replacementConstraints = new Set(
      (params.replacementActionContract?.hardConstraints || []).map((entry) =>
        canonicalJson(entry),
      ),
    );
    const removed = constraints.find(
      (constraint) => !replacementConstraints.has(canonicalJson(constraint)),
    );
    if (removed) {
      throw new Error(
        `The successor Plan cannot remove the explicit constraint: ${removed.description}`,
      );
    }
  }

  async buildProposal(
    input: Omit<
      PlanAmendmentProposal,
      "version" | "amendmentId" | "proposalDigest" | "createdAt"
    > & { now?: number },
  ): Promise<PlanAmendmentProposal> {
    const now = input.now ?? Date.now();
    const rationale = requiredText(input.rationale, "Amendment rationale");
    const { now: _now, ...payload } = input;
    const proposalDigest = await this.digest({
      version: 1,
      ...payload,
      rationale,
    });
    return {
      version: 1,
      ...payload,
      rationale,
      amendmentId: `${input.executionId}:amendment:${proposalDigest.slice(-16)}`,
      proposalDigest,
      createdAt: now,
    };
  }

  async authorize(
    proposal: PlanAmendmentProposal,
    authority: PlanAmendmentAuthority,
    now = Date.now(),
  ): Promise<PlanAmendmentGrant> {
    const existing = await loadPlanAmendmentGrantByProposalDigest(
      proposal.proposalDigest,
    );
    if (existing) {
      if (existing.authority !== authority) {
        throw new Error("A Plan amendment grant cannot change authority");
      }
      if (existing.status === "failed") {
        const reauthorized: PlanAmendmentGrant = {
          ...existing,
          status: "authorized",
          authorizedAt: now,
          appliedAt: undefined,
          failedAt: undefined,
          failureReason: undefined,
        };
        await Zotero.DB.executeTransaction(async () => {
          await updatePlanAmendmentGrant(reauthorized);
          await updatePlanAmendmentProposalStatus(
            proposal.proposalDigest,
            "authorized",
            now,
          );
        });
        return reauthorized;
      }
      return existing;
    }
    const grant: PlanAmendmentGrant = {
      version: 1,
      grantId: `${proposal.amendmentId}:grant`,
      proposal,
      authority,
      status: "authorized",
      authorizedAt: now,
    };
    await Zotero.DB.executeTransaction(async () => {
      await savePlanAmendmentProposal(proposal, "authorized", now);
      await savePlanAmendmentGrant(grant);
      await updatePlanAmendmentProposalStatus(
        proposal.proposalDigest,
        "authorized",
        now,
      );
    });
    return grant;
  }

  async stageProposal(
    proposal: PlanAmendmentProposal,
    status: "awaiting_approval" | "authorized" = "awaiting_approval",
    now = Date.now(),
  ): Promise<void> {
    await savePlanAmendmentProposal(proposal, status, now);
  }

  async supersedeProposal(
    priorProposalDigest: string,
    successor: PlanAmendmentProposal,
    now = Date.now(),
  ): Promise<void> {
    await Zotero.DB.executeTransaction(async () => {
      await savePlanAmendmentProposal(successor, "awaiting_approval", now);
      await updatePlanAmendmentProposalStatus(
        priorProposalDigest,
        "superseded",
        now,
      );
    });
  }

  async markProposalFailed(
    proposal: PlanAmendmentProposal,
    now = Date.now(),
  ): Promise<void> {
    await updatePlanAmendmentProposalStatus(
      proposal.proposalDigest,
      "failed",
      now,
    );
  }

  async authorizeActionScopeAmendment(params: {
    plan: Extract<PlanRuntimeContext, { phase: "executing" }>;
    conversationKey: number;
    failure: ScopeValidationFailure;
    actionProposal: ActionProposal;
    authority: PlanAmendmentAuthority;
    rationale?: string;
    now?: number;
  }): Promise<PlanAmendmentGrant> {
    const details = params.failure.amendableObligation;
    if (
      params.failure.code !== "added_target" ||
      !details ||
      !details.addedTargetIds.length ||
      details.boundaryKind === undefined
    ) {
      throw new Error(
        "Only a host-validated addition inside an approved source can receive an action-scope amendment grant.",
      );
    }
    const [artifact, ledger] = await Promise.all([
      loadPlanArtifact(params.plan.planId, params.plan.revision),
      loadPlanExecutionLedger(params.plan.executionId),
    ]);
    if (
      !artifact ||
      !ledger ||
      artifact.digest !== params.plan.approvedDigest ||
      ledger.planDigest !== params.plan.approvedDigest ||
      artifact.status !== "approved" ||
      ledger.executionId !== params.plan.executionId ||
      ["failed", "cancelled", "superseded"].includes(ledger.status) ||
      artifact.conversationKey !== params.conversationKey ||
      ledger.conversationKey !== params.conversationKey
    ) {
      throw new Error(
        "The Plan or conversation identity changed before the scope amendment could be authorized.",
      );
    }
    const previousScopeDigest = await this.digest({
      obligationId: details.obligationId,
      libraryID: details.libraryID,
      targets: details.previousTargetIds,
    });
    const resultingScopeDigest = await this.digest({
      obligationId: details.obligationId,
      libraryID: details.libraryID,
      targets: details.currentTargetIds,
    });
    const targetSetDigest = await this.digest({
      libraryID: details.libraryID,
      targets: details.addedTargetIds,
    });
    const proposal = await this.buildProposal({
      kind: "action_scope",
      goalImpact: "within_goal",
      planId: artifact.planId,
      planRevision: artifact.revision,
      planDigest: artifact.digest,
      executionId: ledger.executionId,
      executionDigest: await this.executionIdentityDigest(ledger),
      conversationKey: artifact.conversationKey,
      previousScopeDigest,
      resultingScopeDigest,
      targetSetDigest,
      proposalPayloadDigest: params.actionProposal.payloadDigest,
      addedActionTargets: details.addedTargetIds.map((id) => `item:${id}`),
      rationale:
        params.rationale ||
        `New targets remain inside the approved ${details.boundaryKind} source for ${details.obligationId}.`,
      now: params.now,
    });
    return this.authorize(proposal, params.authority, params.now);
  }

  async actionScopeGrantMatches(params: {
    grant: PlanAmendmentGrant;
    failure: ScopeValidationFailure;
    actionProposal: ActionProposal;
  }): Promise<boolean> {
    const details = params.failure.amendableObligation;
    if (
      params.grant.status !== "authorized" ||
      params.grant.proposal.kind !== "action_scope" ||
      params.failure.code !== "added_target" ||
      !details ||
      params.grant.proposal.proposalPayloadDigest !==
        params.actionProposal.payloadDigest
    ) {
      return false;
    }
    const [previousScopeDigest, resultingScopeDigest, targetSetDigest] =
      await Promise.all([
        this.digest({
          obligationId: details.obligationId,
          libraryID: details.libraryID,
          targets: details.previousTargetIds,
        }),
        this.digest({
          obligationId: details.obligationId,
          libraryID: details.libraryID,
          targets: details.currentTargetIds,
        }),
        this.digest({
          libraryID: details.libraryID,
          targets: details.addedTargetIds,
        }),
      ]);
    return (
      params.grant.proposal.previousScopeDigest === previousScopeDigest &&
      params.grant.proposal.resultingScopeDigest === resultingScopeDigest &&
      params.grant.proposal.targetSetDigest === targetSetDigest
    );
  }

  async applyResearchScopeAmendment(params: {
    plan: Extract<PlanRuntimeContext, { phase: "executing" }>;
    conversationKey: number;
    addedTargets: readonly Readonly<{ libraryID: number; itemKey: string }>[];
    rationale: string;
    authority: PlanAmendmentAuthority;
    now?: number;
  }): Promise<{
    grant: PlanAmendmentGrant;
    job: ResearchJob;
    previousItemCount: number;
    newItemCount: number;
  }> {
    if (!this.gateway) {
      throw new Error("Research scope amendment requires the Zotero gateway");
    }
    const now = params.now ?? Date.now();
    const [artifact, ledger, job] = await Promise.all([
      loadPlanArtifact(params.plan.planId, params.plan.revision),
      loadPlanExecutionLedger(params.plan.executionId),
      loadResearchJobForExecution(params.plan.executionId),
    ]);
    const investigation = artifact?.contract?.investigation;
    if (
      !artifact ||
      !ledger ||
      !job ||
      !investigation?.scopeSnapshot ||
      artifact.digest !== params.plan.approvedDigest ||
      ledger.planDigest !== params.plan.approvedDigest ||
      artifact.status !== "approved" ||
      ledger.executionId !== params.plan.executionId ||
      ["failed", "cancelled", "superseded"].includes(ledger.status) ||
      artifact.conversationKey !== params.conversationKey ||
      ledger.conversationKey !== params.conversationKey
    ) {
      throw new Error(
        "The Plan, execution, or conversation identity changed before research scope amendment.",
      );
    }
    if (investigation.scopeAmendmentPolicy !== "within_source") {
      throw new Error(
        "This research contract has a fixed scope; create a successor Plan revision.",
      );
    }
    if (["failed", "cancelled"].includes(job.status)) {
      throw new Error(
        "A terminal failed or cancelled research job cannot be amended",
      );
    }
    const [priorRef, priorItems, priorCorpus] = await Promise.all([
      loadScopeSnapshotRef(job.snapshotId),
      listScopeSnapshotItems(job.snapshotId),
      listResearchCorpusItems({ researchJobId: job.researchJobId }),
    ]);
    if (!priorRef || priorItems.length !== job.totalItems) {
      throw new Error("The effective research snapshot is incomplete");
    }
    const priorSnapshotIdentities = new Set(
      priorItems.map((item) => `${item.libraryID}:${item.itemKey}`),
    );
    if (
      priorCorpus.length !== priorItems.length ||
      priorCorpus.some(
        (item) =>
          !priorSnapshotIdentities.has(`${item.libraryID}:${item.itemKey}`),
      )
    ) {
      throw new Error(
        "The durable research corpus does not match the effective snapshot",
      );
    }
    const successor = await buildResearchScopeSuccessorSnapshot({
      gateway: this.gateway,
      planId: artifact.planId,
      revision: artifact.revision,
      priorRef,
      priorItems,
      scope: investigation.scope,
      addedTargets: params.addedTargets,
      priorLineageDigest:
        job.scopeLineageDigest ||
        priorRef.scopeLineageDigest ||
        priorRef.digest,
      now,
    });
    const targetSetDigest = await this.digest(params.addedTargets);
    const proposal = await this.buildProposal({
      kind: "research_scope",
      goalImpact: "within_goal",
      planId: artifact.planId,
      planRevision: artifact.revision,
      planDigest: artifact.digest,
      executionId: ledger.executionId,
      executionDigest: await this.executionIdentityDigest(ledger),
      conversationKey: artifact.conversationKey,
      previousScopeDigest: priorRef.digest,
      resultingScopeDigest: successor.ref.digest,
      targetSetDigest,
      proposalPayloadDigest: await this.digest({
        targets: params.addedTargets,
        rationale: params.rationale,
      }),
      addedTargets: params.addedTargets,
      rationale: params.rationale,
      now,
    });
    let grant = await this.authorize(proposal, params.authority, now);
    const nextJob: ResearchJob = {
      ...job,
      version: 2,
      baseSnapshotId:
        job.baseSnapshotId || investigation.scopeSnapshot.snapshotId,
      snapshotId: successor.ref.snapshotId,
      scopeLineageDigest: successor.ref.scopeLineageDigest!,
      status: "running",
      activeStage: "inventory",
      coverageStatus: undefined,
      totalItems: successor.items.length,
      deepReadPlanned:
        investigation.readingStrategy === "adaptive"
          ? successor.items.length
          : job.deepReadPlanned,
      exceptionGrant: undefined,
      completedAt: undefined,
      updatedAt: now,
    };
    try {
      await Zotero.DB.executeTransaction(async () => {
        await saveScopeSnapshot({
          planId: artifact.planId,
          revision: artifact.revision,
          conversationKey: artifact.conversationKey,
          ref: successor.ref,
          items: successor.items,
          alreadyInTransaction: true,
        });
        for (const item of successor.addedItems) {
          await appendResearchCorpusItem({
            version: 1,
            researchJobId: job.researchJobId,
            executionId: job.executionId,
            parentTaskId: job.parentTaskId,
            libraryID: item.libraryID,
            itemKey: item.itemKey,
            localItemId: item.localItemId,
            ordinal: item.ordinal,
            screeningStatus: "pending",
            criterionResults: {},
            inventoryRecorded: false,
            hasAbstract: false,
            attachmentItemKeys: [],
            duplicateAttachmentKeys: [],
            readable: Boolean(item.attachmentFingerprint),
            indexed: false,
            sourceFingerprint:
              item.attachmentFingerprint || item.metadataFingerprint,
            updatedAt: now,
          });
          await saveResearchWorkItem({
            version: 1,
            workItemId: `${job.researchJobId}:work:inventory:${item.libraryID}:${item.itemKey}`,
            researchJobId: job.researchJobId,
            executionId: job.executionId,
            parentTaskId: job.parentTaskId,
            libraryID: item.libraryID,
            itemKey: item.itemKey,
            stage: "inventory",
            subquestionIds: [],
            status: "pending",
            attemptCount: 0,
            evidenceRefs: [],
            createdAt: now,
            updatedAt: now,
          });
        }
        await invalidateResearchGraph(job.researchJobId, now);
        await invalidateLatestResearchMutationApprovalGrant(
          job.executionId,
          now,
        );
        await saveResearchJob(nextJob, artifact.conversationKey);
        await planExecutionCoordinator.reopenForScopeAmendment({
          executionId: ledger.executionId,
          scopeLineageDigest: nextJob.scopeLineageDigest!,
          now,
          alreadyInTransaction: true,
        });
        grant = await this.markApplied(grant, now);
      });
    } catch (error) {
      await this.markFailed(grant, error, now);
      throw error;
    }
    return {
      grant,
      job: nextJob,
      previousItemCount: priorItems.length,
      newItemCount: successor.items.length,
    };
  }

  async migrateSuccessorExecutionState(params: {
    predecessorExecutionId: string;
    successorExecutionId: string;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<void> {
    const migrate = () =>
      this.migrateSuccessorExecutionStateInTransaction(params);
    if (params.alreadyInTransaction) await migrate();
    else await Zotero.DB.executeTransaction(migrate);
  }

  private async migrateSuccessorExecutionStateInTransaction(params: {
    predecessorExecutionId: string;
    successorExecutionId: string;
    now?: number;
  }): Promise<void> {
    const now = params.now ?? Date.now();
    const [oldLedger, newLedger, oldJob, newJob] = await Promise.all([
      loadPlanExecutionLedger(params.predecessorExecutionId),
      loadPlanExecutionLedger(params.successorExecutionId),
      loadResearchJobForExecution(params.predecessorExecutionId),
      loadResearchJobForExecution(params.successorExecutionId),
    ]);
    if (!oldLedger || !newLedger || oldLedger.planId !== newLedger.planId) {
      throw new Error(
        "Successor migration requires adjacent executions of one Plan",
      );
    }
    const reusableResearchIdentities = new Set<string>();
    const reusableResearchFingerprints = new Map<string, string>();
    if (oldJob && newJob) {
      const [oldCorpus, newCorpus, oldEvidence, oldFindings, newArtifact] =
        await Promise.all([
          listResearchCorpusItems({ researchJobId: oldJob.researchJobId }),
          listResearchCorpusItems({ researchJobId: newJob.researchJobId }),
          listResearchEvidence(oldJob.researchJobId),
          listPaperFindings(oldJob.researchJobId),
          loadPlanArtifact(newLedger.planId, newLedger.revision),
        ]);
      const oldByIdentity = new Map(
        oldCorpus.map((item) => [`${item.libraryID}:${item.itemKey}`, item]),
      );
      const evidenceRefMap = new Map<string, string>();
      {
        for (const current of newCorpus) {
          const identity = `${current.libraryID}:${current.itemKey}`;
          const prior = oldByIdentity.get(identity);
          if (
            !prior ||
            !prior.sourceFingerprint ||
            prior.sourceFingerprint !== current.sourceFingerprint
          ) {
            continue;
          }
          reusableResearchIdentities.add(identity);
          reusableResearchFingerprints.set(identity, current.sourceFingerprint);
          await saveResearchCorpusItem({
            ...current,
            screeningStatus: prior.screeningStatus,
            criterionResults: prior.criterionResults,
            decisionReason: prior.decisionReason,
            inventoryRecorded: prior.inventoryRecorded,
            hasAbstract: prior.hasAbstract,
            attachmentItemKeys: prior.attachmentItemKeys,
            duplicateAttachmentKeys: prior.duplicateAttachmentKeys,
            readable: prior.readable,
            indexed: prior.indexed,
            updatedAt: now,
          });
        }
        const inventoryWork = await listResearchWorkItems({
          researchJobId: newJob.researchJobId,
          stage: "inventory",
        });
        for (const work of inventoryWork) {
          if (
            reusableResearchIdentities.has(`${work.libraryID}:${work.itemKey}`)
          ) {
            await saveResearchWorkItem({
              ...work,
              status: "completed",
              leaseOwner: undefined,
              leaseExpiresAt: undefined,
              updatedAt: now,
            });
          }
        }
        for (const evidence of oldEvidence) {
          const identity = `${evidence.libraryID}:${evidence.itemKey}`;
          if (
            evidence.sourceFingerprint !==
            reusableResearchFingerprints.get(identity)
          ) {
            continue;
          }
          const evidenceRef = `${newJob.researchJobId}:migrated:${evidence.evidenceRef}`;
          evidenceRefMap.set(evidence.evidenceRef, evidenceRef);
          await saveResearchEvidence({
            ...evidence,
            evidenceRef,
            researchJobId: newJob.researchJobId,
            executionId: newJob.executionId,
            parentTaskId: newJob.parentTaskId,
            createdAt: now,
          });
        }
        const validSubquestions = new Set(
          newArtifact?.contract?.investigation?.subquestions.map(
            (entry) => entry.id,
          ) || [],
        );
        const validCriteria = new Set(
          newArtifact?.contract?.investigation?.criteria.map(
            (entry) => entry.id,
          ) || [],
        );
        for (const finding of oldFindings) {
          const identity = `${finding.libraryID}:${finding.itemKey}`;
          if (
            finding.sourceFingerprint !==
            reusableResearchFingerprints.get(identity)
          ) {
            continue;
          }
          const evidenceRefs = finding.evidenceRefs
            .map((ref) => evidenceRefMap.get(ref))
            .filter((ref): ref is string => Boolean(ref));
          await savePaperFinding({
            ...finding,
            findingId: `${newJob.researchJobId}:migrated:${finding.findingId}`,
            researchJobId: newJob.researchJobId,
            executionId: newJob.executionId,
            parentTaskId: newJob.parentTaskId,
            subquestionIds: finding.subquestionIds.filter((id) =>
              validSubquestions.has(id),
            ),
            criterionIds: finding.criterionIds.filter((id) =>
              validCriteria.has(id),
            ),
            evidenceRefs,
            createdAt: now,
          });
        }
        const migratedCorpus = await listResearchCorpusItems({
          researchJobId: newJob.researchJobId,
        });
        const migratedEvidence = await listResearchEvidence(
          newJob.researchJobId,
        );
        const bodyKeys = new Set(
          migratedEvidence
            .filter(
              (entry) =>
                entry.version === 2 &&
                Boolean(entry.observationId) &&
                ["body", "figure", "quote"].includes(entry.sourceKind),
            )
            .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
        );
        await saveResearchJob(
          {
            ...newJob,
            screenedItems: migratedCorpus.filter(
              (entry) => entry.screeningStatus !== "pending",
            ).length,
            candidateItems: migratedCorpus.filter((entry) =>
              ["candidate", "included", "unresolved", "unreadable"].includes(
                entry.screeningStatus,
              ),
            ).length,
            deepReadCompleted: bodyKeys.size,
            updatedAt: now,
          },
          newLedger.conversationKey,
        );
      }
    }

    const oldEvidence = await listExecutionTaskEvidence(oldLedger.executionId);
    const migratedMutationEvidence = new Map<string, TaskEvidence[]>();
    const sameActionContract =
      Boolean(oldLedger.actionContractId) &&
      oldLedger.actionContractId === newLedger.actionContractId;
    for (const evidence of oldEvidence) {
      const reusableMutation =
        sameActionContract &&
        evidence.kind === "mutation_receipt" &&
        evidence.receipt?.verification === "verified" &&
        ["applied", "already_satisfied", "observed"].includes(
          evidence.receipt.status,
        );
      const reusableRead =
        evidence.kind === "verified_read" &&
        evidence.payload?.type === "verified_read" &&
        evidence.payload.observations?.some((observation) =>
          observation.sourceFingerprint
            ? observation.sourceFingerprint ===
              reusableResearchFingerprints.get(
                `${observation.libraryID}:${observation.itemKey}`,
              )
            : false,
        );
      if (!reusableMutation && !reusableRead) continue;
      const receiptObligationId = evidence.receipt?.obligationId;
      const task = newLedger.tasks.find((candidate) =>
        reusableMutation
          ? candidate.expectedEffect === "mutation" &&
            Boolean(receiptObligationId) &&
            candidate.obligationIds.includes(receiptObligationId || "")
          : candidate.completionRequirements?.some(
              (requirement) => requirement.kind === "verified_read",
            ),
      );
      const requirement = task?.completionRequirements?.find((candidate) =>
        reusableMutation
          ? candidate.kind === "mutation_receipts"
          : candidate.kind === "verified_read",
      );
      if (!task || !requirement) continue;
      const payload =
        reusableRead && evidence.payload?.type === "verified_read"
          ? {
              ...evidence.payload,
              sources: evidence.payload.sources?.filter(
                (source) =>
                  Boolean(source.sourceFingerprint) &&
                  source.sourceFingerprint ===
                    reusableResearchFingerprints.get(
                      `${source.libraryID}:${source.itemKey}`,
                    ),
              ),
              observations: evidence.payload.observations?.filter(
                (observation) =>
                  Boolean(observation.sourceFingerprint) &&
                  observation.sourceFingerprint ===
                    reusableResearchFingerprints.get(
                      `${observation.libraryID}:${observation.itemKey}`,
                    ),
              ),
            }
          : evidence.payload;
      const migratedEvidence: TaskEvidence = {
        ...evidence,
        evidenceId: `${newLedger.executionId}:migrated:${evidence.evidenceId}`,
        executionId: newLedger.executionId,
        taskId: task.taskId,
        requirementId: requirement.requirementId,
        criterionIds: requirement.criterionIds,
        contractDigest: requirement.contractDigest,
        payload,
        createdAt: now,
      };
      await saveTaskEvidence(migratedEvidence);
      if (reusableMutation) {
        const taskEvidence = migratedMutationEvidence.get(task.taskId) || [];
        taskEvidence.push(migratedEvidence);
        migratedMutationEvidence.set(task.taskId, taskEvidence);
      }
    }
    if (migratedMutationEvidence.size) {
      const tasks = newLedger.tasks.map((task) => {
        const evidence = migratedMutationEvidence.get(task.taskId);
        if (!evidence?.length) return task;
        const evidenceIds = evidence.map((entry) => entry.evidenceId);
        try {
          assertTaskCompletionEvidence(task, evidence);
        } catch {
          return { ...task, evidenceIds, updatedAt: now };
        }
        return {
          ...task,
          status: "completed" as const,
          evidenceIds,
          completedAt: now,
          updatedAt: now,
        };
      });
      const allCompleted = tasks.every((task) =>
        ["completed", "skipped"].includes(task.status),
      );
      await savePlanExecutionLedger(
        {
          ...newLedger,
          tasks,
          status: allCompleted ? "completed" : newLedger.status,
          activeTaskId: tasks.some(
            (task) =>
              task.taskId === newLedger.activeTaskId &&
              task.status === "in_progress",
          )
            ? newLedger.activeTaskId
            : undefined,
          completedAt: allCompleted ? now : newLedger.completedAt,
          updatedAt: now,
        },
        undefined,
        { alreadyInTransaction: true },
      );
    }
  }

  async markApplied(
    grant: PlanAmendmentGrant,
    now = Date.now(),
  ): Promise<PlanAmendmentGrant> {
    if (grant.status === "applied") return grant;
    const applied: PlanAmendmentGrant = {
      ...grant,
      status: "applied",
      appliedAt: now,
      failedAt: undefined,
      failureReason: undefined,
    };
    await updatePlanAmendmentGrant(applied);
    await updatePlanAmendmentProposalStatus(
      grant.proposal.proposalDigest,
      "applied",
      now,
    );
    return applied;
  }

  async markFailed(
    grant: PlanAmendmentGrant,
    error: unknown,
    now = Date.now(),
  ): Promise<PlanAmendmentGrant> {
    const failed: PlanAmendmentGrant = {
      ...grant,
      status: "failed",
      failedAt: now,
      failureReason: error instanceof Error ? error.message : String(error),
    };
    await updatePlanAmendmentGrant(failed);
    await updatePlanAmendmentProposalStatus(
      grant.proposal.proposalDigest,
      "failed",
      now,
    );
    return failed;
  }
}

export const planAmendmentService = new PlanAmendmentService();
