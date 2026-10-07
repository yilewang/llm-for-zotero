import { renderAgentTrace } from "./agentTrace/render";
import { resolveCodexNativeHostInteractionWithTrace } from "./codexNative/turnCallbacks";
import { createCodexNativeActivityTraceControllerForTests } from "./codexNativeTrace/controller";
import type { Message } from "./types";
import { agentRunTraceCache } from "./agentState";
import { getConversationKey } from "./conversationIdentity";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import {
  buildNativeQuestionAction,
  nativeQuestionAnswers,
} from "../../codexAppServer/nativeQuestions";

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
    streaming: true,
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
          events: message.streaming
            ? message.pendingAgentTraceEvents || []
            : agentRunTraceCache.get(message.agentRunId || "") || [],
        });
        host.replaceChildren(...(rendered ? [rendered] : []));
      }, 0);
    },
  );
  const questions = [
    {
      id: "audience",
      question: "Which audience?",
      options: [{ label: "Students" }, { label: "Researchers" }],
    },
  ];
  const pending = resolveCodexNativeHostInteractionWithTrace({
    body,
    trace,
    action: buildNativeQuestionAction(questions),
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
    const answer = nativeQuestionAnswers(questions, await pending);
    await Zotero.Promise.delay(50);
    trace.finish("The plan is ready for review.");
    // Native completion first supplies its durable host journal identity.
    // That journal does not contain the UI-owned clarification transcript.
    message.agentRunId = `native-host-question-${message.timestamp}`;
    agentRunTraceCache.set(message.agentRunId, [
      {
        runId: message.agentRunId,
        seq: 1,
        eventType: "final",
        payload: { type: "final", text: "The plan is ready for review." },
        createdAt: Date.now(),
      },
    ]);
    message.streaming = false;
    await Zotero.Promise.delay(50);
    const conversationKey = getConversationKey(item);
    await trace.persist(
      conversationKey,
      getConversationWriteGeneration(conversationKey),
    );
    await Zotero.Promise.delay(50);
    const historyRow = Array.from(
      chat.querySelectorAll<HTMLElement>(
        ".llm-agent-process-action-expandable",
      ),
    ).find((row) =>
      Boolean(row?.textContent?.includes("Answered 1 planning question")),
    );
    return {
      cardsWhilePending,
      answer,
      cardsAfterResolution: chat.querySelectorAll(".llm-planning-question-card")
        .length,
      activeControlsAfter: chat.querySelectorAll(
        ".llm-planning-question-card button:not(:disabled), .llm-planning-question-card input:not(:disabled)",
      ).length,
      questionHistoryText: historyRow?.textContent || "",
    };
  } finally {
    await pending;
    agentRunTraceCache.delete(`native-host-question-${message.timestamp}`);
    host.remove();
    chat
      .querySelectorAll(".llm-action-inline-card")
      .forEach((card) => card.remove());
  }
}
