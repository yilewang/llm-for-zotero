/** Native behavior checks for the ordinary Chat rendering path. */
import {
  buildAgentEngineDepsForTests,
  ensureConversationLoaded,
  getConversationKey,
  requestChatScrollFollowBottom,
} from "./chat";
import {
  chatHistory,
  nextRequestId,
  tryBeginRequest,
  finishRequest,
} from "./state";
import {
  endInlineEdit,
  getInlineEditBorrowedInputSection,
  getInlineEditTarget,
} from "./inlineEditState";
import { buildContextUsagePresentation } from "./textUtils";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { persistChatScrollSnapshotForConversationKey } from "./chatScrollSnapshots";
import type { Message } from "./types";

export async function exerciseChatRenderingLifecycle(panel: {
  body: HTMLElement;
  item: Zotero.Item;
}) {
  const { body, item } = panel;
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  const previousStyle = body.getAttribute("style");
  if (body.hasAttribute("data-llm-workflow-test")) {
    body.style.left = "0";
    body.style.zIndex = "99999";
  }
  await ensureConversationLoaded(item);
  const key = getConversationKey(item);
  const timestamp = Date.now();
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: timestamp + 3,
    runMode: "chat",
    streaming: true,
    modelName: "Replay model",
    reasoningSummary: "Original **thinking**.",
    reasoningOpen: true,
  };
  chatHistory.set(key, [
    { role: "user", text: "Earlier question", timestamp },
    {
      role: "assistant",
      text: "A completed historical paragraph with retained evidence.\n\n".repeat(
        40,
      ),
      timestamp: timestamp + 1,
    },
    { role: "user", text: "New question", timestamp: timestamp + 2 },
    message,
  ]);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Replay conversation is busy");
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
  const wrapper = () =>
    box.querySelector<HTMLElement>(
      `.llm-message-wrapper[data-message-timestamp="${message.timestamp}"]`,
    )!;
  const settle = () => Zotero.Promise.delay(160);
  try {
    helpers.refreshChatSafely();
    await settle();
    const initialWrapper = wrapper();
    message.text =
      "# Stable heading\n\nStable paragraph for selection.\n\nSecond paragraph.\n\nUnfinished tail";
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const heading = wrapper().querySelector("h1,h2,h3,h4");
    const paragraph = wrapper().querySelector(".llm-assistant-answer p")!;
    const thinking = wrapper().querySelector<HTMLDetailsElement>(
      ".llm-agent-reasoning",
    )!;
    const composer = ui.inputBox!;
    composer.value = "Preserved draft";
    composer.focus({ preventScroll: true });
    const historicalParagraph = box.querySelector(
      ".llm-message-wrapper.assistant .llm-assistant-answer p",
    )!;
    box.dispatchEvent(
      new win.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
    );
    box.scrollTop = 10;
    persistChatScrollSnapshotForConversationKey(key, box);
    const before =
      historicalParagraph.getBoundingClientRect().top -
      box.getBoundingClientRect().top;
    for (let n = 0; n < 4; n++) {
      message.text += ` with evidence ${n}.`;
      helpers.refreshAssistantMessageSafely(message);
      await settle();
    }
    const stableWrapper = wrapper() === initialWrapper;
    const stableHeading = wrapper().querySelector("h1,h2,h3,h4") === heading;
    const thinkingPreserved =
      wrapper().querySelector(".llm-agent-reasoning") === thinking &&
      thinking.open;
    const composerPreserved =
      composer.value === "Preserved draft" && doc.activeElement === composer;
    const manualScrollDelta =
      historicalParagraph.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      before;
    const selection = win.getSelection()!;
    const range = doc.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();
    message.text += " More streaming text.";
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const selectionPreserved =
      Boolean(selectedText) &&
      selection.toString() === selectedText &&
      paragraph.isConnected;
    selection.removeAllRanges();
    requestChatScrollFollowBottom(body, item, box);
    for (let n = 0; n < 3; n++) {
      message.text += "\n\nFollowing additional content at the bottom. ".repeat(
        8,
      );
      helpers.refreshAssistantMessageSafely(message);
      await settle();
    }
    const followBottomGap = box.scrollHeight - box.clientHeight - box.scrollTop;
    message.reasoningSummary = "Updated thinking remains visible.";
    message.modelName = "Updated model";
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const thinkingUpdated =
      wrapper().textContent?.includes("Updated thinking remains visible.") &&
      wrapper().textContent?.includes("Updated model");
    const quote = "The quotation remains readable throughout streaming.";
    message.text = `# Final answer\n\n> ${quote}\n>\n> (Workflow, 2026)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[source][ref]\n\n[ref]: https://example.org/paper`;
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const streamingQuoteReadable =
      wrapper().textContent?.includes(quote) &&
      !wrapper().textContent?.includes("[[quote-occurrence:");
    message.streaming = false;
    helpers.refreshAssistantMessageSafely(message);
    await settle();
    const finalQuoteReadable =
      wrapper()
        .querySelector(".llm-quote-card")
        ?.textContent?.includes(quote) &&
      !wrapper().textContent?.includes("[[quote-occurrence:");
    const finalControlsPresent = Boolean(
      wrapper().querySelector(".llm-message-action-copy"),
    );
    const canonicalFinal =
      Boolean(wrapper().querySelector("table")) &&
      Boolean(wrapper().querySelector('a[href="https://example.org/paper"]'));
    // Queue one incremental update, then finalize before its frame can run.
    message.streaming = true;
    message.text = "Before cancellation";
    helpers.refreshChatSafely();
    message.text += " stale queued text";
    helpers.refreshAssistantMessageSafely(message);
    message.text = "Preserved cancelled answer";
    message.streaming = false;
    message.interrupted = true;
    helpers.refreshChatSafely();
    await settle();
    const cancellationPreserved =
      wrapper().textContent?.includes("Preserved cancelled answer") &&
      !wrapper().textContent?.includes("stale queued text");
    return {
      stableWrapper,
      stableHeading,
      thinkingPreserved,
      composerPreserved,
      selectionPreserved,
      manualScrollDelta,
      followBottomGap,
      thinkingUpdated: Boolean(thinkingUpdated),
      streamingQuoteReadable: Boolean(streamingQuoteReadable),
      finalQuoteReadable: Boolean(finalQuoteReadable),
      finalControlsPresent,
      canonicalFinal,
      cancellationPreserved: Boolean(cancellationPreserved),
    };
  } finally {
    finishRequest(key, requestId);
    if (previousStyle === null) body.removeAttribute("style");
    else body.setAttribute("style", previousStyle);
  }
}

/**
 * Prompt-level probes for a rendered chat turn, shared by this replay and by
 * the live workflow harness so both read the same controls the user sees.
 */
export function createChatTurnPromptProbes(body: HTMLElement): {
  wrapperOf: (message: Message) => HTMLElement | null;
  probePromptMenu: (
    message: Message,
  ) => { handled: boolean; enabled: boolean } | null;
  isPromptEditable: (message: Message) => boolean;
  hidePromptMenu: () => void;
} {
  const win = body.ownerDocument.defaultView!;
  // A turn's optimistic prompt and answer can share one timestamp, so the role
  // has to be part of the match or both resolve to the prompt wrapper.
  const wrapperOf = (message: Message): HTMLElement | null =>
    body
      .querySelector<HTMLElement>("#llm-chat-box")
      ?.querySelector<HTMLElement>(
        `.llm-message-wrapper[data-message-role="${message.role}"][data-message-timestamp="${Math.floor(
          message.timestamp,
        )}"]`,
      ) || null;
  const hidePromptMenu = () =>
    body
      .querySelector<HTMLElement>("#llm-prompt-menu")
      ?.style.setProperty("display", "none");
  const probePromptMenu = (
    message: Message,
  ): { handled: boolean; enabled: boolean } | null => {
    const bubble =
      wrapperOf(message)?.querySelector<HTMLElement>(".llm-bubble");
    const promptMenu = body.querySelector<HTMLElement>("#llm-prompt-menu");
    const deleteButton = promptMenu?.querySelector<HTMLButtonElement>(
      "#llm-prompt-menu-delete",
    );
    if (!bubble || !promptMenu || !deleteButton) return null;
    deleteButton.disabled = true;
    const event = new win.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 10,
      clientY: 10,
    });
    bubble.dispatchEvent(event);
    const probe = {
      // The turn's own handler is the first thing to preventDefault.
      handled: event.defaultPrevented,
      enabled: !deleteButton.disabled,
    };
    promptMenu.style.display = "none";
    return probe;
  };
  const isPromptEditable = (message: Message): boolean =>
    Boolean(
      wrapperOf(message)
        ?.querySelector(".llm-bubble.user")
        ?.classList.contains("llm-bubble-editable"),
    );
  return { wrapperOf, probePromptMenu, isPromptEditable, hidePromptMenu };
}

export type CompletedChatTurnRefreshResult = {
  promptMenuAvailable: boolean;
  promptMenuHandledWhileStreaming: boolean;
  promptLockedWhileStreaming: boolean;
  earlierPromptLockedWhileStreaming: boolean;
  earlierPromptEditableAfterTurn: boolean;
  earlierPromptClickOpensEditor: boolean;
  earlierPromptEditorUsesOriginalText: boolean;
  promptMenuHandledAfterTurn: boolean;
  earlierAnswerWrapperPreserved: boolean;
  earlierPromptWrapperPreserved: boolean;
  earlierAnswerTextPreserved: boolean;
  promptWrapperRerendered: boolean;
  promptEditableAfterTurn: boolean;
  promptDeletableAfterTurn: boolean;
  answerNoLongerStreaming: boolean;
  answerCopyActionPresent: boolean;
  answerQuoteCardRendered: boolean;
  contextUsageShowsStoredSnapshot: boolean;
};

/**
 * Finishing an ordinary Chat turn must update only that turn: the answer stops
 * streaming and its prompt regains edit/delete, while every earlier turn keeps
 * its rendered DOM (a full rebuild re-parses the whole conversation).
 */
export async function exerciseCompletedChatTurnRefresh(panel: {
  body: HTMLElement;
  item: Zotero.Item;
}): Promise<CompletedChatTurnRefreshResult> {
  const { body, item } = panel;
  const previousStyle = body.getAttribute("style");
  if (body.hasAttribute("data-llm-workflow-test")) {
    body.style.left = "0";
    body.style.zIndex = "99999";
  }
  await ensureConversationLoaded(item);
  const key = getConversationKey(item);
  const timestamp = Date.now();
  const earlierPrompt: Message = {
    role: "user",
    text: "Earlier question",
    timestamp,
  };
  const earlierAnswerText =
    "A completed historical paragraph with retained evidence.\n\n".repeat(20);
  const earlierAnswer: Message = {
    role: "assistant",
    text: earlierAnswerText,
    timestamp: timestamp + 1,
    runMode: "chat",
  };
  const prompt: Message = {
    role: "user",
    text: "New question",
    timestamp: timestamp + 2,
  };
  const answer: Message = {
    role: "assistant",
    text: "",
    timestamp: timestamp + 3,
    runMode: "chat",
    streaming: true,
    modelName: "Replay model",
  };
  chatHistory.set(key, [earlierPrompt, earlierAnswer, prompt, answer]);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Replay conversation is busy");
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  const settle = () => Zotero.Promise.delay(160);
  const { wrapperOf, probePromptMenu, isPromptEditable } =
    createChatTurnPromptProbes(body);
  try {
    helpers.refreshChatSafely();
    await settle();
    const earlierAnswerWrapper = wrapperOf(earlierAnswer);
    const earlierPromptWrapper = wrapperOf(earlierPrompt);
    const streamingPromptWrapper = wrapperOf(prompt);
    const streamingProbe = probePromptMenu(prompt);
    const promptMenuAvailable = streamingProbe !== null;
    const promptMenuHandledWhileStreaming = streamingProbe?.handled === true;
    // A prompt whose answer is still streaming offers neither edit nor delete.
    const promptLockedWhileStreaming =
      !isPromptEditable(prompt) && streamingProbe?.enabled === false;
    wrapperOf(earlierPrompt)
      ?.querySelector<HTMLElement>(".llm-bubble")
      ?.click();
    await settle();
    const earlierPromptLockedWhileStreaming =
      !isPromptEditable(earlierPrompt) && !getInlineEditTarget(body);
    for (let n = 0; n < 3; n++) {
      answer.text += `Streaming paragraph ${n} with evidence.\n\n`;
      helpers.refreshAssistantMessageSafely(answer);
      await settle();
    }
    // Provider usage for the finished turn is stored before the turn-end
    // refresh, exactly as the streaming usage handler stores it.
    deps.setContextUsageSnapshot(key, {
      contextTokens: 12345,
      contextWindow: 200000,
      estimated: false,
      source: "provider",
      contextWindowIsAuthoritative: true,
    });
    const quote = "The quotation remains readable after the turn completes.";
    answer.text = `# Final answer\n\n> ${quote}\n>\n> (Workflow, 2026)\n\nClosing paragraph.`;
    answer.streaming = false;
    helpers.refreshCompletedAssistantTurnSafely(answer);
    await settle();
    const answerWrapper = wrapperOf(answer)!;
    const tokenUsageEl = body.querySelector<HTMLElement>("#llm-token-usage");
    const expectedUsageText = buildContextUsagePresentation({
      sessionTokens: 12345,
      contextWindow: 200000,
      estimated: false,
    }).text;
    const result = {
      promptMenuAvailable,
      promptMenuHandledWhileStreaming,
      promptLockedWhileStreaming,
      earlierPromptLockedWhileStreaming,
      earlierPromptEditableAfterTurn: isPromptEditable(earlierPrompt),
      earlierAnswerWrapperPreserved:
        Boolean(earlierAnswerWrapper) &&
        wrapperOf(earlierAnswer) === earlierAnswerWrapper &&
        Boolean(earlierAnswerWrapper?.isConnected),
      earlierPromptWrapperPreserved:
        Boolean(earlierPromptWrapper) &&
        wrapperOf(earlierPrompt) === earlierPromptWrapper,
      earlierAnswerTextPreserved: Boolean(
        earlierAnswerWrapper?.textContent?.includes(
          "A completed historical paragraph with retained evidence.",
        ),
      ),
      promptWrapperRerendered:
        Boolean(streamingPromptWrapper) &&
        Boolean(wrapperOf(prompt)) &&
        wrapperOf(prompt) !== streamingPromptWrapper,
      promptEditableAfterTurn: isPromptEditable(prompt),
      ...(() => {
        const probe = probePromptMenu(prompt);
        return {
          promptMenuHandledAfterTurn: probe?.handled === true,
          promptDeletableAfterTurn: probe?.enabled === true,
        };
      })(),
      answerNoLongerStreaming:
        !answerWrapper.querySelector(".llm-bubble.streaming") &&
        !answerWrapper.querySelector(".llm-typing"),
      answerCopyActionPresent: Boolean(
        answerWrapper.querySelector(".llm-message-action-copy"),
      ),
      answerQuoteCardRendered: Boolean(
        answerWrapper
          .querySelector(".llm-quote-card")
          ?.textContent?.includes(quote) &&
        !answerWrapper.textContent?.includes("[[quote-occurrence:"),
      ),
      contextUsageShowsStoredSnapshot: Boolean(
        expectedUsageText &&
        tokenUsageEl?.textContent === expectedUsageText &&
        tokenUsageEl?.style.display !== "none",
      ),
    };
    wrapperOf(earlierPrompt)
      ?.querySelector<HTMLElement>(".llm-bubble")
      ?.click();
    await settle();
    return {
      ...result,
      earlierPromptClickOpensEditor:
        getInlineEditTarget(body)?.userTimestamp === earlierPrompt.timestamp &&
        Boolean(
          wrapperOf(earlierPrompt)?.querySelector(".llm-inline-edit-wrapper"),
        ),
      earlierPromptEditorUsesOriginalText:
        getInlineEditBorrowedInputSection(
          body,
        ).el?.querySelector<HTMLTextAreaElement>("#llm-input")?.value ===
        earlierPrompt.text,
    };
  } finally {
    endInlineEdit(body);
    body
      .querySelector<HTMLElement>("#llm-prompt-menu")
      ?.style.setProperty("display", "none");
    finishRequest(key, requestId);
    if (previousStyle === null) body.removeAttribute("style");
    else body.setAttribute("style", previousStyle);
  }
}
