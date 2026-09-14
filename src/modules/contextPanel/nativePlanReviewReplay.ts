import { createPreparePlanExecutionTool } from "../../agent/tools/plan/preparePlanExecution";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import { finalizeNativePlanProposal } from "../../agent/plans/nativePlanning";
import {
  clearPlanConversationRowsInTransaction,
  loadPlanArtifact,
  loadLatestPlanExecutionForPlan,
} from "../../agent/plans/store";
import { renderAgentTrace } from "./agentTrace/render";
import { clearPlanModeState } from "./planModeState";
import { resolveAgentRuntimeRequest } from "../../agent/context/resolvedAgentRequest";
import type { AgentRunEventRecord, AgentToolContext } from "../../agent/types";
import {
  createCodexNativeActivityTraceControllerForTests,
  resolveCodexNativeApprovalWithOptionalReviewCard,
} from "./chat";
import type { Message } from "./types";
import { createAbortController } from "../../utils/apiHelpers";

/** Reproduce native confirmation followed by the queued assistant trace render. */
export async function exerciseNativeQuestionReview(
  body: Element,
  item: Zotero.Item,
) {
  const doc = body.ownerDocument;
  const chat = body.querySelector<HTMLElement>("#llm-chat-box")!;
  const host = doc.createElement("div");
  chat.appendChild(host);
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    runMode: "agent",
  };
  let scheduled = false;
  const trace = createCodexNativeActivityTraceControllerForTests(
    message,
    () => {
      if (scheduled) return;
      scheduled = true;
      doc.defaultView!.setTimeout(() => {
        scheduled = false;
        const rendered = renderAgentTrace({
          doc,
          panelItem: item,
          message,
          events: message.pendingAgentTraceEvents || [],
        });
        host.replaceChildren(...(rendered ? [rendered] : []));
      }, 0);
    },
  );
  const controller = createAbortController();
  const pending = resolveCodexNativeApprovalWithOptionalReviewCard({
    body,
    trace,
    request: {
      method: "item/tool/requestUserInput",
      signal: controller.signal,
      params: {
        threadId: "workflow-thread",
        turnId: "workflow-turn",
        itemId: "workflow-question",
        questions: [
          {
            id: "audience",
            question: "Which audience?",
            options: [{ label: "Students" }, { label: "Researchers" }],
          },
        ],
      },
    },
    setStatusSafely: () => {},
  });
  try {
    await Zotero.Promise.delay(50);
    const cardsWhilePending = chat.querySelectorAll(
      ".llm-planning-question-card",
    ).length;
    const card = chat.querySelector<HTMLElement>(
      ".llm-planning-question-card",
    )!;
    card
      .querySelector<HTMLButtonElement>('[data-option-id="option-1"]')!
      .click();
    card
      .querySelector<HTMLButtonElement>(".llm-planning-question-continue")!
      .click();
    const answer = await pending;
    await Zotero.Promise.delay(50);
    return {
      cardsWhilePending,
      answer,
      activeControlsAfter: chat.querySelectorAll(
        ".llm-planning-question-card button:not(:disabled), .llm-planning-question-card input:not(:disabled)",
      ).length,
    };
  } finally {
    controller.abort();
    await pending;
    host.remove();
    chat
      .querySelectorAll(".llm-action-inline-card")
      .forEach((card) => card.remove());
  }
}

/** Exercise the loaded renderer against disposable native Zotero state. */
export async function exerciseNativePlanReview() {
  const item = new Zotero.Item("journalArticle");
  item.libraryID = Zotero.Libraries.userLibraryID;
  item.setField("title", "Native planning workflow fixture");
  await item.saveTx();
  const key = item.id;
  const planId = `native-workflow-${Date.now()}`;
  const plan = {
    phase: "planning" as const,
    provider: "codex" as const,
    planId,
    revision: 1,
    nativePlanning: {
      attemptId: planId,
      threadId: "workflow-thread",
      turnId: "workflow-turn",
      ephemeral: false,
    },
  };
  const doc = Zotero.getMainWindow().document;
  let rendered: HTMLElement | null = null;
  try {
    const tool = createPreparePlanExecutionTool(new ZoteroGateway());
    const input = tool.validate({
      contract: { deliverable: { kind: "answer" } },
      steps: [
        {
          content: "Explain the agreed concept",
          activeForm: "Explaining the concept",
          expectedEffect: "reasoning",
          acceptanceCriteria: [
            {
              criterionId: "explanation",
              description: "A bounded explanation",
              verifier: "bounded_reasoning",
            },
          ],
        },
      ],
    });
    if (!input.ok) throw new Error(input.error);
    await tool.execute(input.value, {
      request: resolveAgentRuntimeRequest({
        conversationKey: key,
        libraryID: item.libraryID,
        mode: "agent",
        userText: "Plan a conceptual explanation",
        planContext: plan,
      }),
      runId: "workflow-turn",
      item,
    } as AgentToolContext);
    const stagedStatus = (await loadPlanArtifact(planId, 1))?.status;
    const markdown =
      "# Native proposal\n\nExplain **representational drift** using a concrete example.\n\n- State the assumptions.\n- Explain the result.";
    const artifact = await finalizeNativePlanProposal({
      plan,
      conversationKey: key,
      proposal: {
        threadId: "workflow-thread",
        turnId: "workflow-turn",
        itemId: "proposal",
        text: markdown,
      },
    });
    const events: AgentRunEventRecord[] = [
      {
        runId: planId,
        seq: 1,
        eventType: "plan_ready",
        createdAt: Date.now(),
        payload: { type: "plan_ready", artifact },
      },
    ];
    rendered = renderAgentTrace({
      doc,
      panelItem: item,
      message: {
        role: "assistant",
        text: "The plan is ready for review.",
        timestamp: Date.now(),
        runMode: "agent",
        pendingAgentTraceEvents: events,
      },
      events,
    });
    if (!rendered) throw new Error("The native plan card did not render");
    doc.documentElement.appendChild(rendered);
    const heading = rendered.querySelector(
      ".llm-plan-markdown h2",
    )?.textContent;
    const strong = rendered.querySelector(
      ".llm-plan-markdown strong",
    )?.textContent;
    const summary = rendered.querySelector(
      ".llm-plan-contract-summary",
    )?.textContent;
    (rendered!.querySelector(".llm-plan-approve") as HTMLElement).click();
    const deadline = Date.now() + 5000;
    while (
      (await loadPlanArtifact(planId, 1))?.status !== "approved" &&
      Date.now() < deadline
    )
      await Zotero.Promise.delay(20);
    const approved = await loadPlanArtifact(planId, 1);
    const ledger = await loadLatestPlanExecutionForPlan(planId, 1);
    return {
      stagedStatus,
      heading,
      strong,
      summary,
      approvedStatus: approved?.status,
      markdown: approved?.nativePlanning?.proposal?.markdown,
      digestMatches:
        approved?.digest === artifact.digest &&
        ledger?.planDigest === artifact.digest,
      continuationId: ledger?.providerContinuationId,
      nativeTitle: Zotero.Items.get(key).getField("title"),
      cardText: rendered.textContent,
    };
  } finally {
    rendered?.remove();
    clearPlanModeState(key);
    await Zotero.DB.executeTransaction(() =>
      clearPlanConversationRowsInTransaction(key),
    );
    await item.eraseTx();
  }
}
