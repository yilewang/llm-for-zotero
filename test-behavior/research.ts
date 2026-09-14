import {
  enableComposePlanMode,
  getPlanningRuntimeContext,
  stageApprovedPlanExecution,
} from "../src/modules/contextPanel/planModeState";
import { planExecutionCoordinator } from "../src/agent/plans/coordinator";
import {
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../src/agent/plans/store";
import {
  loadLatestPlanDocumentForExecution,
  loadPlanDocumentOutbox,
} from "../src/agent/documents/store";
import {
  loadResearchJobForExecution,
  listResearchCorpusItems,
  listPaperFindings,
  listResearchEvidence,
} from "../src/agent/research/store";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import { assertExact, check } from "./core";
import { snapshot } from "./native";
import type { JourneyContext } from "./journeys";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { LiveDriver } from "./driver";

declare const Zotero: any;

export async function researchJourney(ctx: JourneyContext) {
  const { fixtures: f, harness, write, request } = ctx;
  const driver = new LiveDriver(
    ctx.driver.creds,
    write,
    3600000,
    ctx.driver.inspectEffectState,
  );
  let papers: any[];
  if (request.tier === "smoke") {
    papers = [];
    for (let i = 0; i < 8; i++) {
      const fixture = await harness.createPaperWithPdfFixture({
        title: `Synthetic population coding study ${i + 1} ${f.marker}`,
        pdfTitle: `Mini review study ${i + 1}`,
        pages: [
          `Synthetic test study ${i + 1}. Population coding and representational drift. Hypothesis: stable readout persists as tuning changes.`,
          `Methods: simulated recordings over ${10 + i} sessions, linear population decoding, shuffled-cell control. Results: intact accuracy ${0.8 - i * 0.02}, shuffled accuracy 0.5. No biological experiment was performed.`,
          `Limitations: simulated data, linear readout, finite sessions. Implication: compare single-cell drift with readout stability. This is a deliberately synthetic fixture, not a published finding.`,
        ],
      });
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCollections([f.collections["mini-review"].id]);
      await item.saveTx();
      papers.push(item);
    }
  } else {
    const collections = Zotero.Collections.getByLibrary(
      f.libraryID,
      true,
    ).filter((c: any) => c.name === request.collection);
    if (collections.length !== 1)
      return {
        status: "BLOCKED" as const,
        detail: `Expected exactly one current collection named ${request.collection}; found ${collections.length}. Use --collection to select it explicitly.`,
      };
    papers = collections[0]
      .getChildItems(false)
      .filter((item: any) => item.isRegularItem())
      .sort(
        (a: any, b: any) =>
          String(a.getField("title")).localeCompare(
            String(b.getField("title")),
          ) || a.key.localeCompare(b.key),
      )
      .slice(0, 55);
    if (papers.length < 50)
      return {
        status: "BLOCKED" as const,
        detail: `Full research needs 50–55 papers; current collection contains ${papers.length}.`,
      };
  }
  const before = await snapshot();
  const scope = await Promise.all(
    papers.map(async (item) => ({
      libraryID: item.libraryID,
      itemId: item.id,
      itemKey: item.key,
      title: item.getField("title"),
      metadataHash: await sha256Text(JSON.stringify(item.toJSON())),
      attachments: item
        .getAttachments()
        .map((id: number) => Zotero.Items.get(id).key),
    })),
  );
  await write("research.review/scope.json", {
    source:
      request.tier === "smoke" ? "synthetic-mini-review" : request.collection,
    capturedAt: new Date().toISOString(),
    scopeHash: await sha256Text(JSON.stringify(scope)),
    papers: scope,
  });
  await harness.openStandaloneForItem(f.items.primary.id);
  await harness.startNewStandaloneConversation();
  const ui = await harness.addItemsAsStandaloneContext(
    papers.map((item) => item.id),
  );
  const conversationKey = ui.conversationKey;
  check(conversationKey, "Research chat has no durable conversation identity");
  harness.enableLiveAgentSending();
  const planning = enableComposePlanMode({
    conversationKey,
    provider: "original",
  });
  const contexts = await Promise.all(
    papers.map(async (item) => ({
      libraryID: item.libraryID,
      itemId: item.id,
      contextItemId: (await item.getBestAttachment())?.id || item.id,
      title: item.getField("title"),
    })),
  );
  const base: Partial<AgentRuntimeRequestInput> = {
    conversationKey,
    conversationKind: "global",
    scopeType: "custom",
    scopeLabel: `Frozen ${papers.length}-paper review`,
    selectedPaperContexts: contexts,
  };
  const planningPrompt = `Plan a critical literature review of population coding and representational drift using exactly the ${papers.length} selected papers. Read available bodies, record durable per-paper understandings and disclose unavailable bodies. Discuss mechanisms, methods, conflicting results and limitations, with citations, references and a coverage section. Publish a complete document; do not change Zotero items or import papers. ${request.tier === "smoke" ? "These are synthetic test papers; prominently identify that limitation." : "Use this current scope, not a prior release corpus."}`;
  await driver.turn(
    "research.review",
    planningPrompt,
    "auto",
    { ...base, planContext: getPlanningRuntimeContext(conversationKey) },
    "none",
    () => harness.askStandalone(planningPrompt),
  );
  const artifact = await loadPlanArtifact(planning.planId, planning.revision);
  await write("research.review/plan.json", artifact);
  check(
    artifact?.status === "awaiting_approval",
    "Planning did not produce an approvable plan; inspect the recorded question or failure",
  );
  const ledger = await planExecutionCoordinator.approve({
    planId: artifact.planId,
    revision: artifact.revision,
    conversationGeneration: getConversationWriteGeneration(conversationKey),
    actionContract: artifact.actionContract,
  });
  await write("research.review/approval.json", {
    approvedBy: "explicit manual behavior-suite invocation",
    approvalCount: 1,
    ledger,
  });
  stageApprovedPlanExecution(ledger);
  const executionPrompt =
    "Execute the approved plan to completion and publish the final literature review.";
  await driver.turn(
    "research.review",
    executionPrompt,
    "auto",
    base,
    "none",
    () => harness.askStandalone(executionPrompt),
  );
  // Runtime completion precedes chat persistence. Observe the real sender's
  // outbox delivery instead of fabricating a publication acknowledgment.
  const publicationDeadline = Date.now() + 15000;
  while (Date.now() < publicationDeadline) {
    const published = await loadLatestPlanDocumentForExecution(
      ledger.executionId,
    );
    const publication = published
      ? await loadPlanDocumentOutbox(published.documentId)
      : null;
    if (publication && publication.status === "delivered") break;
    await Zotero.Promise.delay(100);
  }
  const finalLedger = await loadPlanExecutionLedger(ledger.executionId);
  const document = await loadLatestPlanDocumentForExecution(ledger.executionId);
  const job = await loadResearchJobForExecution(ledger.executionId);
  const corpus = job
    ? await listResearchCorpusItems({ researchJobId: job.researchJobId })
    : [];
  const findings = job ? await listPaperFindings(job.researchJobId) : [];
  const evidence = job ? await listResearchEvidence(job.researchJobId) : [];
  await write("research.review/checkpoints.json", {
    ledger: finalLedger,
    job,
    corpus,
    findings,
    evidence,
  });
  await write("research.review/document.json", document);
  if (document)
    await write("research.review/review.md", document.visibleMarkdown, true);
  check(
    finalLedger?.status === "completed",
    `Execution stopped before completion: ${finalLedger?.status || "missing ledger"}`,
  );
  check(
    document &&
      document.visibleMarkdown.length > 2000 &&
      document.validation.integrityValidated,
    "No complete integrity-validated document",
  );
  const expected = scope.map((item) => item.itemKey).sort();
  assertExact(
    corpus.map((item) => item.itemKey).sort(),
    expected,
    "Frozen research corpus",
  );
  assertExact(
    document.coverageItems.map((item) => item.itemKey).sort(),
    expected,
    "Document coverage",
  );
  for (const paper of scope) {
    const coverage = document.coverageItems.find(
      (item) => item.itemKey === paper.itemKey,
    )!;
    const grounded =
      findings.some(
        (finding) =>
          finding.itemKey === paper.itemKey &&
          finding.evidenceRefs.length &&
          finding.findings.length,
      ) &&
      evidence.some(
        (record) =>
          record.itemKey === paper.itemKey && record.sourceKind === "body",
      );
    check(
      grounded ||
        (["unreadable", "missing", "unresolved", "excluded"].includes(
          coverage.status,
        ) &&
          Boolean(coverage.reason)),
      `No durable body understanding or explicit exception for ${paper.itemKey}`,
    );
  }
  check(
    document.citationBundle.bibliographyEntries.length > 0,
    "No formatted bibliography",
  );
  assertExact(
    await snapshot(),
    before,
    "Research must not mutate native library items",
  );
  return {
    status: "REVIEW_REQUIRED" as const,
    detail:
      "Machine checks passed. Read research.review/review.md for synthesis, relevance, evidence fidelity and writing quality. This is not a quality pass or a release decision.",
  };
}
