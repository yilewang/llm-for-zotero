/** Native history-loading regression and timing fixture, used only by workflow tests. */
import { getAgentRuntime } from "../../agent";
import { savePlanArtifact } from "../../agent/plans/store";
import type { AgentRunEventRecord } from "../../agent/types";
import type { PlanArtifact } from "../../agent/plans/types";
import {
  buildAgentEngineDepsForTests,
  getConversationKey,
  refreshConversationPanels,
  setAgentRunTraceLoaderForTests,
} from "./chat";
import { chatHistory, activeContextPanels } from "./state";
import { agentRunTraceCache } from "./agentState";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import type { Message } from "./types";

export async function exercisePlanHistoryReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: { historyTurns: number },
) {
  const { body, item } = panel;
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  const box = body.querySelector<HTMLElement>("#llm-chat-box")!;
  const key = getConversationKey(item);
  const stamp = Date.now();
  const prefix = `plan-history-${stamp}`;
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const markdown = `# History loading tutorial\n\n${Array.from(
    { length: 80 },
    (_, i) =>
      `## Example ${i + 1}\n\nA hypothetical cache stores **three entries**. This paragraph explains the example.\n\n| Policy | Eviction |\n| --- | --- |\n| FIFO | Oldest insertion |\n| LRU | Oldest access |`,
  ).join("\n\n")}`;
  await deps.persistConversationMessage(key, {
    role: "user",
    text: "Write a hypothetical tutorial document.",
    timestamp: stamp,
  });
  const prepared = (await getAgentRuntime()
    .getToolDefinition("submit_document")!
    .execute(
      {
        title: "History loading tutorial",
        markdown,
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      {
        request: {
          conversationKey: key,
          mode: "agent",
          libraryID: item.libraryID,
          userText: "Write a hypothetical tutorial document.",
          documentOutcomePolicy: {
            required: true,
            documentKind: "custom",
            integrityPolicy: "authored",
            trigger: "document_intent",
          },
        },
        runId: `${prefix}-document`,
        item,
        modelName: "workflow",
        currentAnswerText: "",
      } as never,
    )) as { documentId: string; visibleMarkdown: string };
  await deps.persistConversationMessage(key, {
    role: "assistant",
    text: prepared.visibleMarkdown,
    timestamp: stamp + 1,
    documentId: prepared.documentId,
  });

  const history: Message[] = [
    { role: "user", text: "Write a tutorial", timestamp: stamp },
    {
      role: "assistant",
      text: prepared.visibleMarkdown,
      timestamp: stamp + 1,
      runMode: "agent",
      documentId: prepared.documentId,
      agentRunId: `${prefix}-document`,
    },
  ];
  agentRunTraceCache.set(`${prefix}-document`, [
    {
      runId: `${prefix}-document`,
      seq: 1,
      eventType: "final",
      createdAt: stamp,
      payload: {
        type: "final",
        text: prepared.visibleMarkdown,
        documentId: prepared.documentId,
      },
    },
  ]);
  const traces = new Map<string, AgentRunEventRecord[]>();
  for (let i = 0; i < input.historyTurns; i++) {
    const runId = `${prefix}-${i}`;
    const artifact: PlanArtifact = {
      version: 1,
      planId: runId,
      revision: 1,
      digest: "fixture",
      provider: "original",
      conversationKey: key,
      status: "approved",
      explanation: `Saved plan ${i + 1}`,
      createdAt: stamp,
      updatedAt: stamp,
      steps: [
        {
          planStepId: "write",
          content: "Write a tutorial",
          activeForm: "Writing a tutorial",
          acceptanceCriteria: [],
          expectedEffect: "artifact",
        },
      ],
    };
    await savePlanArtifact(artifact);
    traces.set(runId, [
      {
        runId,
        seq: 1,
        eventType: "plan_ready",
        createdAt: stamp,
        payload: { type: "plan_ready", artifact },
      },
      ...Array.from(
        { length: 12 },
        (_, n): AgentRunEventRecord => ({
          runId,
          seq: n + 2,
          eventType: "reasoning",
          createdAt: stamp,
          payload: {
            type: "reasoning",
            round: n + 1,
            summary: "Reviewing a hypothetical example. ".repeat(20),
          },
        }),
      ),
      {
        runId,
        seq: 14,
        eventType: "final",
        createdAt: stamp + 1,
        payload: { type: "final", text: "Plan ready." },
      },
    ]);
    history.push(
      {
        role: "user",
        text: `Plan example ${i + 1}`,
        timestamp: stamp + 2 + i * 2,
      },
      {
        role: "assistant",
        text: "Plan ready.",
        timestamp: stamp + 3 + i * 2,
        runMode: "agent",
        agentRunId: runId,
      },
    );
  }
  chatHistory.set(key, history);
  const pending = new Map<string, () => void>();
  let traceReads = 0;
  setAgentRunTraceLoaderForTests(async (runId) => {
    traceReads++;
    await new Promise<void>((resolve) => pending.set(runId, resolve));
    return { run: null, events: traces.get(runId) || [] };
  });
  let documentReads = 0;
  let planReads = 0;
  let ledgerReads = 0;
  let documentMounts = 0;
  let documentPaints = 0;
  let planPaints = 0;
  const query = Zotero.DB.queryAsync;
  Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
    if (/SELECT/i.test(sql)) {
      if (/FROM llm_for_zotero_plan_documents\s/.test(sql)) documentReads++;
      if (/FROM llm_for_zotero_plan_artifacts\s/.test(sql)) planReads++;
      if (/FROM llm_for_zotero_plan_executions\s/.test(sql)) ledgerReads++;
    }
    return (query as Function).call(Zotero.DB, sql, ...args);
  } as typeof query;
  const observer = new win.MutationObserver((mutations) => {
    for (const change of mutations) {
      for (const node of Array.from(change.addedNodes)) {
        if (!(node instanceof win.HTMLElement)) continue;
        documentMounts +=
          Number(node.matches(".llm-plan-document-card")) +
          node.querySelectorAll(".llm-plan-document-card").length;
        const markdownNodes = [
          ...(node.matches(".llm-plan-markdown") ? [node] : []),
          ...Array.from(node.querySelectorAll(".llm-plan-markdown")),
        ];
        for (const markdown of markdownNodes) {
          if (markdown?.parentElement?.closest(".llm-plan-document-card"))
            documentPaints++;
          else planPaints++;
        }
      }
    }
  });
  const frame = () =>
    new Promise<number>((resolve) => {
      const start = win.performance.now();
      win.requestAnimationFrame(() => resolve(win.performance.now() - start));
    });
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(
          `History fixture timed out: ${JSON.stringify({ traceReads, cached: [...traces.keys()].map((id) => agentRunTraceCache.has(id)), text: box.textContent?.slice(-1600), plans: box.querySelectorAll(".llm-plan-container:not(.llm-plan-document-card) > .llm-plan-markdown").length })}`,
        );
      await Zotero.Promise.delay(10);
    }
  };
  body.style.left = "0";
  body.style.zIndex = "99999";
  observer.observe(box, { childList: true, subtree: true });
  const started = win.performance.now();
  try {
    refreshConversationPanels(body, item);
    await waitFor(() =>
      Boolean(
        box.querySelector(
          ".llm-plan-document-completion-caption:not([hidden])",
        ),
      ),
    );
    const documentReadyMs = win.performance.now() - started;
    await waitFor(() => pending.size === input.historyTurns);
    const initialDocumentReads = documentReads;
    const mountedPanels = Array.from(activeContextPanels.values()).filter(
      (getItem) => {
        const target = getItem();
        return target && getConversationKey(target) === key;
      },
    ).length;
    const firstDocument = box.querySelector(".llm-plan-document-card");
    const firstUser = box.firstElementChild;
    const composer = body.querySelector<HTMLTextAreaElement>("#llm-input")!;
    composer.focus();
    composer.value = "History remains interactive";
    const frameMs: number[] = [];
    for (const resolve of pending.values()) {
      resolve();
      frameMs.push(await frame());
      await Zotero.Promise.delay(20);
    }
    await waitFor(
      () =>
        box.querySelectorAll(
          ".llm-plan-container:not(.llm-plan-document-card) > .llm-plan-markdown",
        ).length === input.historyTurns,
    );
    await Zotero.Promise.delay(100);
    const result = {
      historyTurns: input.historyTurns,
      initialDocumentReads,
      mountedPanels,
      traceReads,
      documentReads,
      planReads,
      ledgerReads,
      documentMounts,
      documentPaints,
      planPaints,
      documentReadyMs,
      allPlansReadyMs: win.performance.now() - started,
      frameMs,
      documentRetained:
        box.querySelector(".llm-plan-document-card") === firstDocument,
      userRetained: box.firstElementChild === firstUser,
      inputPreserved:
        doc.activeElement === composer &&
        composer.value === "History remains interactive",
      progressNodes: box.querySelectorAll(".llm-plan-container-execution")
        .length,
      warmOpenMs: 0,
      retainedOnOwnRefresh: false,
      staleDocumentLoadIgnored: false,
    };
    refreshConversationPanels(body, item, {
      chatOptions: { rerenderAssistantMessages: new Set([history[1]]) },
    });
    result.retainedOnOwnRefresh =
      box.querySelector(".llm-plan-document-card") === firstDocument &&
      !Array.from(
        box.querySelectorAll<HTMLElement>(".llm-assistant-answer"),
      ).some(
        (node) =>
          node &&
          !(node as HTMLElement).hidden &&
          node.textContent?.includes("History loading tutorial"),
      );
    const warmStart = win.performance.now();
    refreshConversationPanels(body, item);
    await waitFor(() =>
      Boolean(
        box.querySelector(
          ".llm-plan-document-completion-caption:not([hidden])",
        ),
      ),
    );
    result.warmOpenMs = win.performance.now() - warmStart;
    let held = false;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
      const rows = await (query as Function).call(Zotero.DB, sql, ...args);
      if (!held && /FROM llm_for_zotero_plan_documents\s/.test(sql)) {
        held = true;
        await delayed;
      }
      return rows;
    } as typeof query;
    try {
      refreshConversationPanels(body, item);
      await waitFor(() => held);
      const detached = box.querySelector(".llm-plan-document-card")!;
      refreshConversationPanels(body, item);
      await waitFor(() =>
        Boolean(
          box.querySelector(
            ".llm-plan-document-completion-caption:not([hidden])",
          ),
        ),
      );
      release();
      await Zotero.Promise.delay(50);
      result.staleDocumentLoadIgnored =
        !detached.isConnected && detached.textContent === "Loading document…";
    } finally {
      release();
    }
    return result;
  } finally {
    observer.disconnect();
    Zotero.DB.queryAsync = query;
    for (const resolve of pending.values()) resolve();
    setAgentRunTraceLoaderForTests();
    body.style.left = "-10000px";
  }
}
