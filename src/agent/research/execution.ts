import { ToolInputRejection } from "../tools/execution/failure";
import { buildPaperDisplayLabels } from "../../shared/paperDisplayLabels";
import { inspectResearch } from "./inspection";
import { recordResearchReductions } from "./recordReductions";
import { planExecutionCoordinator } from "../plans/coordinator";
import {
  listExecutionTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../plans/store";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { validateObject } from "../tools/shared";
import { type ResearchUpdateInput } from "./commands";
import { shouldCheckpointResearchExpansion } from "./policy";
import { progress, recomputeJob, reconcileResearchStage } from "./progress";
import { buildReadingManifest, type ReadingManifestEntry } from "./reading";
import {
  PROJECTED_PAPER_RECORD_TOKENS,
  resolveRecordBatchCap,
} from "./readingBudget";
import { resolveOutputReserve } from "../../utils/outputTokenPolicy";
import {
  applyFrameRevision,
  applyHostTiering,
  applyTierDecisions,
  corpusHasHostTiers,
  decorateReadingManifest,
  parseTierDecisions,
} from "./synthesisControls";
import { buildCorpusMap } from "./tiering";
import { listResearchEdges } from "./store";
import { buildGraphView } from "./graphView";
import {
  advanceSynthesisPhase,
  currentPhase,
  describeNextWork,
  recordResearchEdges,
  recordResearchQuestions,
  resolveResearchQuestions,
  updateResearchEdges,
} from "./graphLoop";
import type { ResearchSynthesisPhase } from "./types";
import { validateStoredResearchTransition } from "./stages";
import {
  listPaperFindings,
  listResearchCorpusItems,
  listResearchEvidence,
  listResearchWorkItems,
  listScopeSnapshotItems,
  loadResearchJobForExecution,
} from "./store";

import type { AgentToolContext } from "../types";
import { finalizeResearch } from "./finalize";
import { inventoryResearchScope } from "./inventory";
import { recordResearchPapers } from "./recordPapers";
import { nextScreenBatch } from "./screening";
import type { CompleteResearchWorkItem } from "./work";
import { completeResearchWorkItem } from "./work";
export async function executeResearchUpdate(
  gateway: ZoteroGateway,
  input: ResearchUpdateInput,
  context: AgentToolContext,
) {
  const plan = context.request.planContext;
  if (!plan || plan.phase !== "executing") {
    throw new ToolInputRejection(
      "research_update requires approved plan execution",
    );
  }
  let job = await loadResearchJobForExecution(plan.executionId);
  if (!job) throw new ToolInputRejection("This plan has no research job");
  if (
    job.status === "waiting_for_user" &&
    !(
      input.operation === "finalize" &&
      (input.outcome === "partial" || input.outcome === "failed")
    )
  ) {
    throw new ToolInputRejection(
      "Research is waiting for the deep-read checkpoint; call approve_research_expansion so the selected mode can decide, or finalize a user-authorized partial result",
    );
  }
  const executionLedger = await loadPlanExecutionLedger(plan.executionId);
  const activeTask = executionLedger?.tasks.find(
    (entry) => entry.taskId === plan.activeTaskId,
  );
  if (!activeTask || activeTask.expectedEffect === "mutation") {
    throw new ToolInputRejection(
      "Research updates require an active non-mutation plan task",
    );
  }
  const artifact = await loadPlanArtifact(plan.planId, plan.revision);
  const investigation = artifact?.contract?.investigation;
  if (!artifact || !investigation || !artifact.contractDigest) {
    throw new ToolInputRejection(
      "The approved research contract is unavailable",
    );
  }
  if (job.contractDigest !== artifact.contractDigest) {
    throw new ToolInputRejection(
      "Research job contract digest no longer matches the plan",
    );
  }
  const adaptiveReview =
    investigation.readingStrategy === "adaptive" &&
    investigation.reviewMode !== "systematic";
  if (input.operation === "inventory_scope")
    job = await reconcileResearchStage(
      job,
      context.request.conversationKey,
      adaptiveReview,
    );
  const corpus = await listResearchCorpusItems({
    researchJobId: job.researchJobId,
  });
  const corpusByKey = new Map(
    corpus.map((entry) => [`${entry.libraryID}:${entry.itemKey}`, entry]),
  );
  const snapshot = await listScopeSnapshotItems(job.snapshotId);
  const snapshotByKey = new Map(
    snapshot.map((entry) => [`${entry.libraryID}:${entry.itemKey}`, entry]),
  );
  const displayLabels = buildPaperDisplayLabels(
    snapshot.map((entry) => ({
      ...entry,
      identity: `${entry.libraryID}:${entry.itemKey}`,
    })),
  );
  const taskEvidence = await listExecutionTaskEvidence(plan.executionId);
  const verifiedReads = new Map(
    taskEvidence
      .filter(
        (entry) =>
          entry.kind === "verified_read" && entry.verified && entry.reference,
      )
      .map((entry) => [
        entry.reference!,
        entry.payload?.type === "verified_read"
          ? entry.payload.observations || []
          : [],
      ]),
  );
  if (input.operation === "next_screen_batch") {
    return await nextScreenBatch({
      adaptiveReview,
      job,
      corpus,
      context,
      investigation,
    });
  }
  if (
    ["list_verified_reads", "list_findings", "list_themes"].includes(
      input.operation,
    )
  )
    return inspectResearch({
      input,
      job,
      investigation,
      corpus,
      snapshotByKey,
      taskEvidence,
    });
  if (input.operation === "next_work") {
    return describeNextWork({ job, corpus });
  }
  if (input.operation === "list_graph") {
    return buildGraphView({
      job,
      corpus,
      investigation,
      snapshotByKey,
      displayLabels,
    });
  }
  const allowedCriteria = new Set(
    investigation.criteria.map((entry) => entry.id),
  );
  const allowedSubquestions = new Set(
    investigation.subquestions.map((entry) => entry.id),
  );
  const existingEvidence = await listResearchEvidence(job.researchJobId);
  const evidenceByRef = new Map(
    existingEvidence.map((entry) => [entry.evidenceRef, entry]),
  );
  const newEvidenceRefs: Record<string, string> = {};
  const completeWorkItem = (params: Parameters<CompleteResearchWorkItem>[0]) =>
    completeResearchWorkItem(job!, params);
  const maxPapersPerRecord = adaptiveReview
    ? resolveRecordBatchCap({
        outputReserveTokens: resolveOutputReserve(
          context.request.advanced?.outputTokenLimit,
          context.request.model || context.modelName || "",
          {
            apiBase: context.request.apiBase,
            protocol: context.request.providerProtocol,
            authMode: context.request.authMode,
            profileOverride: context.request.advanced?.profileOverride,
          },
        ),
        projectedPaperTokens: PROJECTED_PAPER_RECORD_TOKENS,
      })
    : undefined;
  if (
    input.operation === "record_papers" &&
    maxPapersPerRecord !== undefined &&
    input.papers.length > maxPapersPerRecord
  ) {
    throw new ToolInputRejection(
      `record_papers accepts at most ${maxPapersPerRecord} papers per call for this model (received ${input.papers.length}). Record this group in smaller calls; every accepted call is durable.`,
    );
  }

  if (input.operation === "set_stage")
    await validateStoredResearchTransition(job, input.stage, adaptiveReview);
  const effectiveStage = job.activeStage;
  const resumesAdaptiveInventory =
    input.operation === "inventory_scope" && effectiveStage !== "inventory";
  if (input.operation === "record_papers" && effectiveStage === "inventory") {
    throw new ToolInputRejection(
      "Use inventory_scope to inventory the frozen corpus, then advance to broad_screening",
    );
  }
  if (
    input.operation === "record_papers" &&
    effectiveStage === "broad_screening" &&
    !adaptiveReview
  ) {
    const issued = await listResearchWorkItems({
      researchJobId: job.researchJobId,
      stage: "broad_screening",
      statuses: ["in_progress"],
    });
    if (!issued.length) {
      throw new ToolInputRejection(
        "Call next_screen_batch before recording broad-screening decisions",
      );
    }
    const expected = new Set(
      issued.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const submitted = new Set(
      (input.papers || []).map((paper) =>
        validateObject<Record<string, unknown>>(paper)
          ? `${Number(paper.libraryID)}:${String(paper.itemKey || "")}`
          : "invalid",
      ),
    );
    if (
      expected.size !== submitted.size ||
      [...expected].some((identity) => !submitted.has(identity))
    ) {
      throw new ToolInputRejection(
        "record_papers must commit exactly the current host-issued screening batch before more work is issued",
      );
    }
  }
  if (
    input.operation === "set_stage" &&
    job.activeStage === "inventory" &&
    input.stage === "broad_screening" &&
    corpus.some((entry) => !entry.inventoryRecorded)
  ) {
    throw new ToolInputRejection(
      "Inventory is incomplete; call inventory_scope before broad screening",
    );
  }
  if (
    input.operation === "record_probes" &&
    effectiveStage !== "recall_expansion"
  ) {
    throw new ToolInputRejection(
      "Recall probes may only be recorded during recall expansion",
    );
  }
  if (
    input.operation === "record_themes" &&
    effectiveStage !== "hierarchical_synthesis"
  ) {
    throw new ToolInputRejection(
      "Theme findings may only be recorded during hierarchical synthesis",
    );
  }
  if (
    input.operation === "record_themes" &&
    job.frame &&
    !["structure", "writing"].includes(currentPhase(job))
  ) {
    throw new ToolInputRejection(
      `Themes are recorded in the structure phase after the edge list is verified; the loop is in the ${currentPhase(job)} phase. Use next_work to see what remains.`,
    );
  }
  if (
    input.operation === "finalize" &&
    input.outcome === "complete" &&
    job.frame &&
    !["writing", "complete"].includes(currentPhase(job))
  ) {
    throw new ToolInputRejection(
      `Research finalizes from the writing phase; the loop is in the ${currentPhase(job)} phase. Advance through links, verification and structure with advance_phase first.`,
    );
  }
  if (
    input.operation === "finalize" &&
    input.outcome === "complete" &&
    job.activeStage !== "hierarchical_synthesis"
  ) {
    throw new ToolInputRejection(
      "Research can finalize only after all six stages",
    );
  }

  let inventoriedItems: number | undefined;
  let readingManifest: ReadingManifestEntry[] | undefined;
  let liveCorpus = corpus;
  if (input.operation === "inventory_scope") {
    ({ inventoriedItems, readingManifest } = await inventoryResearchScope({
      resumesAdaptiveInventory,
      job,
      corpus,
      investigation,
      snapshotByKey,
      completeWorkItem,
      gateway,
    }));
    if (adaptiveReview) {
      liveCorpus = await listResearchCorpusItems({
        researchJobId: job.researchJobId,
      });
      if (!corpusHasHostTiers(liveCorpus)) {
        ({ job, corpus: liveCorpus } = await applyHostTiering({
          job,
          corpus: liveCorpus,
          investigation,
          context,
          conversationKey: context.request.conversationKey,
        }));
      }
    }
  }
  if (input.operation === "set_frame") {
    job = await applyFrameRevision({
      job,
      slots: input.slots,
      conversationKey: context.request.conversationKey,
    });
  }
  if (input.operation === "set_tiers") {
    liveCorpus = await applyTierDecisions({
      job,
      corpus,
      decisions: parseTierDecisions(input.tiers),
    });
  }

  if (input.operation === "record_papers") {
    await recordResearchPapers({
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
    });
  }

  if (
    input.operation === "record_probes" ||
    input.operation === "record_themes"
  )
    await recordResearchReductions({ input, job, corpusByKey, evidenceByRef });

  let graphContent: Record<string, unknown> = {};
  if (input.operation === "record_edges") {
    graphContent = await recordResearchEdges({
      job,
      edges: input.edges,
      corpusByKey,
    });
  }
  if (input.operation === "update_edges") {
    graphContent = await updateResearchEdges({
      job,
      updates: input.edges,
      taskEvidence,
    });
  }
  if (input.operation === "record_questions") {
    graphContent = {
      questions: await recordResearchQuestions({
        job,
        questions: input.questions,
        corpusByKey,
        subquestionIds: allowedSubquestions,
      }),
    };
  }
  if (input.operation === "resolve_questions") {
    graphContent = {
      questions: await resolveResearchQuestions({
        job,
        resolutions: input.questions,
      }),
    };
  }
  if (input.operation === "advance_phase") {
    job = await advanceSynthesisPhase({
      job,
      to: input.phase as ResearchSynthesisPhase,
      corpus,
      conversationKey: context.request.conversationKey,
    });
    graphContent = { phase: job.synthesisPhase };
  }

  let automaticStage =
    input.operation === "set_stage" ? input.stage : undefined;
  let remainingReadingManifest: ReadingManifestEntry[] | undefined;
  let durablePaperCount = 0;
  if (
    adaptiveReview &&
    input.operation === "inventory_scope" &&
    job.activeStage === "inventory"
  ) {
    automaticStage = "broad_screening";
  }
  if (adaptiveReview && input.operation === "record_papers") {
    const [currentCorpus, currentFindings] = await Promise.all([
      listResearchCorpusItems({ researchJobId: job.researchJobId }),
      listPaperFindings(job.researchJobId),
    ]);
    const findingKeys = new Set(
      currentFindings.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    durablePaperCount = findingKeys.size;
    const everyPaperUnderstood = currentCorpus.every(
      (entry) =>
        entry.screeningStatus === "missing" ||
        (!["pending", "candidate"].includes(entry.screeningStatus) &&
          findingKeys.has(`${entry.libraryID}:${entry.itemKey}`)),
    );
    if (everyPaperUnderstood) {
      automaticStage = "hierarchical_synthesis";
      remainingReadingManifest = [];
      // Every node is durable: the loop moves to the link pass.
      if (job.frame && currentPhase(job) === "nodes") {
        job = { ...job, synthesisPhase: "links" };
      }
    } else {
      remainingReadingManifest = await buildReadingManifest({
        corpus: currentCorpus.filter(
          (entry) =>
            entry.screeningStatus !== "missing" &&
            !findingKeys.has(`${entry.libraryID}:${entry.itemKey}`),
        ),
        gateway,
        requiredEvidenceDepth: investigation.requiredEvidenceDepth,
        displayLabels,
      });
    }
  }
  let next = await recomputeJob({
    job,
    conversationKey: context.request.conversationKey,
    activeStage: automaticStage,
    adaptive: adaptiveReview,
  });
  const checkpointRequired =
    !adaptiveReview &&
    shouldCheckpointResearchExpansion({
      approvedEstimate: investigation.estimatedDeepReadPapers,
      actualDeepReadCandidates: next.candidateItems,
      approvedLargeCorpus: investigation.approvedLargeCorpus,
      policy: next.policy,
    }) &&
    next.deepReadPlanned < next.candidateItems;
  if (checkpointRequired && input.operation !== "finalize") {
    next = await recomputeJob({
      job: next,
      conversationKey: context.request.conversationKey,
      status: "waiting_for_user",
    });
  }

  if (input.operation === "finalize") {
    next = await finalizeResearch({
      job,
      input,
      next,
      artifact,
      investigation,
      context,
      plan,
    });
  }

  await context.publishPlanEvent?.({
    type: "plan_research_progress",
    progress: progress(next),
  });
  const decoratedManifest =
    adaptiveReview && readingManifest
      ? decorateReadingManifest({
          manifest: readingManifest,
          corpus: liveCorpus,
          job: next,
          context,
        })
      : undefined;
  const corpusMap =
    adaptiveReview && next.frame
      ? buildCorpusMap({
          corpus: liveCorpus,
          findings: await listPaperFindings(job.researchJobId),
          edges: await listResearchEdges(job.researchJobId),
          labels: displayLabels,
        })
      : undefined;
  const content = {
    progress: progress(next),
    displayLabels: Object.fromEntries(displayLabels),
    inventoriedItems,
    ...(maxPapersPerRecord !== undefined ? { maxPapersPerRecord } : {}),
    ...(adaptiveReview && next.frame
      ? {
          phase: next.synthesisPhase || "nodes",
          frame: next.frame,
          ...(next.nodeCapacity ? { nodeCapacity: next.nodeCapacity } : {}),
        }
      : {}),
    ...(corpusMap ? { corpusMap } : {}),
    ...(readingManifest
      ? {
          readingManifest: decoratedManifest?.entries || readingManifest,
          ...(decoratedManifest
            ? {
                proposedGroups: decoratedManifest.proposedGroups,
                allocatedReadingTokens:
                  decoratedManifest.allocatedReadingTokens,
              }
            : {}),
          instruction: adaptiveReview
            ? readingManifest.length
              ? "Read one proposed group (or your own regrouping of the manifest) with paper_read in each entry's readMode, then immediately record a claim-based node for every identity in that group with record_papers before reading more. Fill every frame slot for core papers; the corpus map shows the papers already recorded so candidate links can name them. The host checkpoints raw text and returns the exact remaining manifest."
              : "No unread papers remain. Continue from list_findings or list_themes without rereading PDFs."
            : "Request the next systematic-review screening batch.",
        }
      : {}),
    checkpointRequired,
    evidenceRefs: newEvidenceRefs,
    ...(input.operation === "record_papers" && input.warnings.length
      ? { warnings: input.warnings }
      : {}),
    ...graphContent,
  };
  if (
    adaptiveReview &&
    input.operation === "record_papers" &&
    remainingReadingManifest
  ) {
    const remainingDecorated = decorateReadingManifest({
      manifest: remainingReadingManifest,
      corpus: liveCorpus,
      job: next,
      context,
    });
    const compactRemainingManifest = remainingDecorated.entries.map(
      (entry) => ({
        identity: entry.identity,
        title: entry.title,
        displayLabel: displayLabels.get(entry.identity),
        readable: entry.readable,
        evidenceDepthTarget: entry.evidenceDepthTarget,
        target: entry.target,
        tier: entry.tier,
        readMode: entry.readMode,
        ...(entry.suggestedQueries
          ? { suggestedQueries: entry.suggestedQueries }
          : {}),
        ...(entry.suggestedMaxChars
          ? { suggestedMaxChars: entry.suggestedMaxChars }
          : {}),
      }),
    );
    const checkpointMap = corpusMap
      ? `\n\nCorpus map (one line per paper):\n${corpusMap.join("\n")}`
      : "";
    const checkpointGroups = compactRemainingManifest.length
      ? `\n\nProposed next groups: ${JSON.stringify(remainingDecorated.proposedGroups)}`
      : "";
    if (!compactRemainingManifest.length) {
      const advancedLedger =
        await planExecutionCoordinator.completeResearchReading({
          executionId: job.executionId,
          researchJobId: job.researchJobId,
          scopeLineageDigest:
            next.scopeLineageDigest || job.scopeLineageDigest || "",
          durablePapers: durablePaperCount,
          totalPapers: next.totalItems,
        });
      await context.publishPlanEvent?.({
        type: "plan_execution_updated",
        ledger: advancedLedger,
      });
    }
    return {
      content,
      continuationCheckpoint: {
        reason: "research_batch_durable",
        instruction: compactRemainingManifest.length
          ? `The completed paper-understanding group is durable. Raw PDF text from that group has been released. The exact remaining frozen-scope manifest below is authoritative. Do not call inventory_scope or otherwise re-verify it. Call paper_read now for the next proposed group (or your own regrouping) using each entry's readMode, immediately persist that group with research_update record_papers as claim-based nodes, and do not reread recorded papers.\n\n${JSON.stringify(compactRemainingManifest)}${checkpointGroups}${checkpointMap}`
          : `All paper understandings are durable and the raw PDF text has been released. Do not call inventory_scope again. The loop is now in the links phase: call research_update list_findings (compact view) to see every node, record an explicit typed edge list with record_edges, then advance_phase to verification and follow next_work. Do not reread the PDFs except to verify an edge.${checkpointMap}`,
      },
    };
  }
  return content;
}
