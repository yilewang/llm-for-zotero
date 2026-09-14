import { PlanExecutionCoordinator } from "../../src/agent/plans/coordinator";

/** An approved single-document plan, created through the real coordinator. */
export async function createDocumentPlan(conversationKey = 41) {
  const coordinator = new PlanExecutionCoordinator();
  const artifact = await coordinator.updateDraft({
    planId: `document-plan-${conversationKey}`,
    conversationKey,
    provider: "original",
    revision: 1,
    ready: true,
    now: 1,
    contract: {
      deliverable: {
        kind: "document",
        spec: {
          kind: "guide",
          title: "Guide",
          requiredSections: ["Guide"],
          requiresReferences: false,
          requiresCoverageSection: false,
          allowFigures: false,
          citationStyle: {
            styleId: "http://www.zotero.org/styles/apa",
            styleTitle: "APA",
            locale: "en-US",
          },
        },
      },
    },
    steps: [
      {
        content: "Publish the guide",
        expectedEffect: "artifact",
        acceptanceCriteria: [
          {
            criterionId: "guide-published",
            description: "The guide is published",
            verifier: "document_published",
          },
        ],
      },
    ],
  });
  const approved = await coordinator.approve({
    planId: artifact.planId,
    revision: 1,
    expectedDigest: artifact.digest,
    conversationGeneration: 1,
    now: 2,
  });
  return coordinator.startNextTask(approved.executionId, 3);
}
