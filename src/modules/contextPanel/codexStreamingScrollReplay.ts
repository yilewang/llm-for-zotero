/** Deterministic Codex callbacks through the mounted production panel. */
import {
  buildAgentEngineDepsForTests,
  getConversationKey,
  refreshConversationPanels,
  requestChatScrollFollowBottom,
} from "./chat";
import { createCodexNativeActivityTraceController } from "./codexNativeTrace/controller";
import { createStreamingResponse } from "./streamingResponse";
import { agentRunTraceCache } from "./agentState";
import {
  chatHistory,
  finishRequest,
  loadedConversationKeys,
  nextRequestId,
  tryBeginRequest,
} from "./state";
import { getChatScrollSnapshot } from "./chatScrollSnapshots";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { buildQuoteCitation } from "../../services/quotes/quoteCitations";
import type { Message } from "./types";

function translatedSection(prefix: string, section: number): string {
  const number = String(section).padStart(2, "0");
  return `${prefix}译文 ${number}：神经群体通过不同细胞的联合活动表征刺激。作者比较训练前后的响应，以解释统计结果及其边界。阅读这一段时，后续生成内容不应改变当前阅读位置。\n\n1. **${prefix}证据 ${number}：** 假设独立噪声的方差为 $\\sigma^2$，样本均值满足 $\\bar{x}=\\frac{1}{n}\\sum_i x_i$。实验条件与对照条件需要分别核对。\n2. **${prefix}限制 ${number}：** 相关性不能直接证明因果关系；这里保留英文术语 population coding，便于返回论文核查。${section % 4 === 0 ? "\n\n$$\\operatorname{Var}(\\bar{x})=\\frac{\\sigma^2}{n}$$" : ""}`;
}

// Matching prefixes model repeated translation/list instructions. The reading
// marker deliberately follows the 160-character text used by scroll anchors.
const sharedListText =
  "论文逐项解释同一实验条件下的神经群体响应。每一项都需要核对样本、对照条件和统计假设，并保留上下文以方便读者比较推导过程。".repeat(
    4,
  );

export async function createCodexStreamingScrollReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  options: { tightList?: boolean } = {},
) {
  const { body, item } = panel;
  const key = getConversationKey(item);
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
  const previousHistory = chatHistory.get(key);
  const timestamp = Date.now();
  const quote = buildQuoteCitation({
    quoteText:
      "Population coding represents a stimulus through joint neuronal activity.",
    citationLabel: "(Workflow, 2026)",
    contextItemId: item.id,
  })!;
  const sections = (prefix: string) =>
    Array.from(
      { length: 18 },
      (_, index) =>
        `${translatedSection(prefix, index + 1)}${(index + 1) % 4 === 0 ? `\n\n[[quote:${quote.id}]]` : ""}`,
    ).join("\n\n");
  const previous: Message = {
    role: "assistant",
    timestamp: timestamp - 2,
    runMode: "agent",
    modelProviderLabel: "Codex",
    text: sections("历史"),
    quoteCitations: [quote],
  };
  const current: Message = {
    role: "assistant",
    timestamp,
    runMode: "agent",
    modelProviderLabel: "Codex",
    modelName: "gpt-5.4",
    text: "",
    streaming: true,
    agentRunId: `codex-scroll-replay-${timestamp}`,
    quoteCitations: [quote],
  };
  chatHistory.set(key, [
    { role: "user", text: "翻译之前的论文段落。", timestamp: timestamp - 3 },
    previous,
    {
      role: "user",
      text: "继续逐段翻译并解释公式。",
      timestamp: timestamp - 1,
    },
    current,
  ]);
  loadedConversationKeys.add(key);
  // The live controller owns pending events; no disk trace lookup is needed.
  agentRunTraceCache.set(current.agentRunId!, []);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Codex scroll replay conversation is already busy");
  const deps = buildAgentEngineDepsForTests(
    item,
    "codex",
    getConversationWriteGeneration(key),
    body,
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  const response = createStreamingResponse({
    message: current,
    refreshMessage: () => helpers.refreshAssistantMessageSafely(current),
    createQueuedRefresh: deps.createQueuedRefresh,
  });
  const trace = createCodexNativeActivityTraceController(
    current,
    response.queueRefresh,
  );
  deps.setRequestUIBusy(body, ui, key, "Codex: 正在逐段核对论文译文");
  response.start();
  trace.noteMcpToolActivity({
    requestId: "initial-paper",
    phase: "completed",
    toolName: "paper_read",
    toolLabel: "读取论文原文",
    arguments: { itemId: item.id },
    workCategory: "retrieval",
    ok: true,
  });
  trace.appendAgentMessageDelta({
    itemId: "translation",
    delta: options.tightList
      ? Array.from(
          { length: 8 },
          (_, index) =>
            `${index + 1}. ${sharedListText}当前证据 ${String(index + 1).padStart(2, "0")}：这一项对应论文中独立编号的证据。`,
        ).join("\n")
      : sections("当前"),
  });
  trace.flushBufferedProgress("event");
  refreshConversationPanels(body, item);
  const readyMarker = options.tightList ? "当前证据 08" : "当前限制 18";
  const readyDeadline = Date.now() + 15000;
  while (!box.textContent?.includes(readyMarker) && Date.now() < readyDeadline)
    await Zotero.Promise.delay(50);
  if (!box.textContent?.includes(readyMarker))
    throw new Error("The native Codex trace did not finish its initial render");
  await Zotero.Promise.delay(400);
  requestChatScrollFollowBottom(body, item, box);
  await Zotero.Promise.delay(300);
  let disposed = false;
  return {
    previousTimestamp: previous.timestamp,
    currentTimestamp: current.timestamp,
    snapshot: () => getChatScrollSnapshot(key, box),
    appendChunk: async (chunk: number) => {
      // A blank line before the next item makes marked render the same list
      // as li > p instead of li. This is an append-only Codex text delta.
      const delta = options.tightList
        ? `\n\n${chunk + 9}. ${sharedListText}追加证据 ${String(chunk + 1).padStart(2, "0")}：继续核对论文中的补充结果。`
        : `\n\n${translatedSection("追加", chunk + 1)}`;
      const parts = delta.match(/[\s\S]{1,28}/g) || [];
      for (let index = 0; index < parts.length; index += 1) {
        trace.appendAgentMessageDelta({
          itemId: "translation",
          delta: parts[index],
        });
        if (index === Math.floor(parts.length / 2)) {
          // These are the callbacks' real response/controller operations: an
          // item boundary flushes text, then the tool/status path repaints it.
          response.flush("event");
          trace.noteMcpToolActivity({
            requestId: `evidence-${chunk}`,
            phase: "started",
            toolName: "paper_read",
            toolLabel: `核查补充证据 ${chunk + 1}`,
            arguments: { itemId: item.id, query: `补充证据 ${chunk + 1}` },
            workCategory: "retrieval",
          });
          helpers.setStatusSafely(
            `Codex: 正在核查第 ${chunk + 1} 组补充证据`,
            "sending",
          );
        }
        await Zotero.Promise.delay(15);
      }
      response.push(
        `\n\n阶段结论 ${chunk + 1}：以上译文已与原文核对，继续生成后续解释。`,
      );
      response.flush("event");
      trace.noteMcpToolActivity({
        requestId: `evidence-${chunk}`,
        phase: "completed",
        toolName: "paper_read",
        toolLabel: `核查补充证据 ${chunk + 1}`,
        arguments: { itemId: item.id, query: `补充证据 ${chunk + 1}` },
        workCategory: "retrieval",
        ok: true,
      });
      trace.appendItemStatus(
        {
          id: `checkpoint-${chunk}`,
          type: "contextCompaction",
          summary: "译文上下文已更新",
        },
        "completed",
      );
      await Zotero.Promise.delay(300);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      response.dispose();
      trace.dispose();
      current.streaming = false;
      finishRequest(key, requestId);
      agentRunTraceCache.delete(current.agentRunId!);
      if (previousHistory) chatHistory.set(key, previousHistory);
      else chatHistory.delete(key);
    },
  };
}
