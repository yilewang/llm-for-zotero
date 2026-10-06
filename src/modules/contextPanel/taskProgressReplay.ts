/**
 * Workflow replays for Task progress beyond a plain agent run: a built-in
 * action run through the production action runner, a native Codex turn
 * through the production callbacks and trace controller, and a stored
 * conversation reopened after a simulated restart.
 */
import { saveAgentRunTraceSnapshot } from "../../agent/store/traceStore";
import type { ActionProgressEvent } from "../../agent/actions";
import type { TaskPaperLedgerDelta } from "../../agent/context/taskPaperLedger";
import type { AgentEvent, AgentRunEventRecord } from "../../agent/types";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { appendMessage } from "../../utils/chatStore";
import { agentRunTraceCache } from "./agentState";
import {
  buildAgentEngineDepsForTests,
  ensureConversationLoaded,
  getConversationKey,
  refreshChat,
  refreshConversationPanels,
} from "./chat";
import { buildCodexNativeTurnCallbacksForTests } from "./codexNative/turnCallbacks";
import { createCodexNativeActivityTraceController } from "./codexNativeTrace/controller";
import { createActionCommandLifecycle } from "./setupHandlers/controllers/actionCommandLifecycle";
import { runAgentActionWithLifecycle } from "./setupHandlers/controllers/actionExecutionRunner";
import {
  chatHistory,
  finishRequest,
  getAbortController,
  loadedConversationKeys,
  nextRequestId,
  tryBeginRequest,
} from "./state";
import { composeContextStore } from "./contexts/composeContextStore";
import { createStreamingResponse } from "./streamingResponse";
import { waitForTaskProgressHydrationForTests } from "./taskProgress/history";
import { flushTaskProgressPanels } from "./taskProgress/panel";
import { clearTaskProgress, completeTaskRun } from "./taskProgress/store";
import type { Message } from "./types";

type Panel = { body: HTMLElement; item: Zotero.Item };

// ---------------------------------------------------------------------------
// A built-in action
// ---------------------------------------------------------------------------

export type TaskProgressActionHandle = {
  conversationKey: number;
  step: (step: string, index: number, total: number) => void;
  summary: (step: string, summary: string) => void;
  /** Resolve the action; `ok: false` fails it with `error`. */
  finish: (
    result: { ok: true; output?: unknown } | { ok: false; error: string },
  ) => Promise<void>;
  /** What the composer stop button does: abort the action's published slot. */
  stop: () => Promise<void>;
  /** Action cards the chat holds right now (the old "Working" card among them). */
  chatCards: () => number;
};

/**
 * Run a built-in action through the production runner and the panel's own
 * lifecycle, as the slash command does, with the action itself scripted.
 */
export async function startTaskProgressAction(
  panel: Panel,
  input: { actionName: string },
): Promise<TaskProgressActionHandle> {
  const { body, item } = panel;
  const conversationKey = getConversationKey(item);
  const chatBox = body.querySelector<HTMLDivElement>("#llm-chat-box");
  const lifecycle = createActionCommandLifecycle({
    body,
    actionHitlPanel: null,
    chatBox,
    registerPendingConfirmation: () => undefined,
    syncHasActionCardAttr: () => undefined,
  });
  let progress: ((event: ActionProgressEvent) => void) | undefined;
  let signal: AbortSignal | undefined;
  let settle: (
    result: { ok: true; output?: unknown } | { ok: false; error: string },
  ) => void = () => undefined;
  let running: Promise<void> = Promise.resolve();
  const started = new Promise<void>((ready) => {
    const run = runAgentActionWithLifecycle({
      actionName: input.actionName,
      input: {},
      requestContext: { mode: "paper", activeItemId: item.id },
      libraryID: item.libraryID,
      conversationKey,
      lifecycle,
      setStatus: () => undefined,
      logError: () => undefined,
      runAction: (async (
        _name: string,
        _input: unknown,
        options: {
          onProgress?: (event: ActionProgressEvent) => void;
          signal?: AbortSignal;
        },
      ) => {
        progress = options.onProgress;
        signal = options.signal;
        ready();
        return new Promise((resolve) => {
          settle = resolve as typeof settle;
        });
      }) as never,
    });
    running = run;
  });
  await started;
  const finish: TaskProgressActionHandle["finish"] = async (result) => {
    settle(result);
    await running;
    await Zotero.Promise.delay(50);
  };
  return {
    conversationKey,
    step: (step, index, total) =>
      progress?.({ type: "step_start", step, index, total }),
    summary: (step, summary) =>
      progress?.({ type: "step_done", step, summary }),
    finish,
    stop: async () => {
      getAbortController(conversationKey)?.abort();
      if (!signal?.aborted) throw new Error("The action was not cancellable");
      await finish({ ok: false, error: "Cancelled by user" });
    },
    chatCards: () =>
      chatBox?.querySelectorAll(
        ".llm-action-progress-card, .llm-action-progress-step",
      ).length || 0,
  };
}

// ---------------------------------------------------------------------------
// A native Codex turn
// ---------------------------------------------------------------------------

export type CodexTaskProgressReplayHandle = {
  conversationKey: number;
  runId: string;
  assistantTimestamp: number;
  planUpdated: (steps: Array<{ content: string; status?: string }>) => void;
  read: (requestId: string, delta: TaskPaperLedgerDelta) => void;
  answer: (text: string) => void;
  /** Finish, persist the run's trace and messages, and end the request. */
  finish: () => Promise<void>;
};

/**
 * A native Codex turn through the production callbacks and trace
 * controller, in the panel's own conversation.
 */
export async function startCodexTaskProgressReplay(
  panel: Panel,
  input: { user: Partial<Message> },
): Promise<CodexTaskProgressReplayHandle> {
  const { body, item } = panel;
  const key = getConversationKey(item);
  const timestamp = Date.now();
  const runId = `codex-task-progress-${timestamp}`;
  const user: Message = {
    role: "user",
    text: "Compare the methods of these papers",
    timestamp,
    ...input.user,
  };
  const assistant: Message = {
    role: "assistant",
    text: "",
    timestamp: timestamp + 1,
    runMode: "agent",
    modelProviderLabel: "Codex",
    modelName: "gpt-5.4",
    streaming: true,
    agentRunId: runId,
  };
  const history = [...(chatHistory.get(key) || []), user, assistant];
  chatHistory.set(key, history);
  loadedConversationKeys.add(key);
  agentRunTraceCache.set(runId, []);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Codex task progress replay: conversation is busy");
  const generation = getConversationWriteGeneration(key);
  const deps = buildAgentEngineDepsForTests(item, "codex", generation, body);
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  const response = createStreamingResponse({
    message: assistant,
    refreshMessage: () => helpers.refreshAssistantMessageSafely(assistant),
    createQueuedRefresh: deps.createQueuedRefresh,
  });
  const trace = createCodexNativeActivityTraceController(
    assistant,
    response.queueRefresh,
  );
  response.start();
  const callbacks = buildCodexNativeTurnCallbacksForTests({
    body,
    item,
    assistantMessage: assistant,
    codexActivityTrace: trace,
    flushResponseStream: (reason) => response.flush(reason),
    setStatusSafely: helpers.setStatusSafely,
    handleDelta: (delta) => response.push(delta),
    handleReasoning: () => undefined,
    handleUsage: () => undefined,
    conversationKey: key,
    conversationGeneration: generation,
  });
  refreshConversationPanels(body, item);
  await Zotero.Promise.delay(100);
  let finished = false;
  return {
    conversationKey: key,
    runId,
    assistantTimestamp: assistant.timestamp,
    planUpdated: (steps) => {
      void callbacks.onPlanUpdated?.({ steps });
    },
    read: (requestId, delta) => {
      void callbacks.onMcpToolActivity?.({
        requestId,
        phase: "completed",
        toolName: delta.toolName,
        toolLabel: "Retrieve Library",
        ok: true,
        workCategory: "retrieval",
        paperLedgerDelta: delta,
      } as never);
    },
    answer: (text) => {
      void callbacks.onDelta?.(text);
      response.flush("event");
    },
    finish: async () => {
      if (finished) return;
      finished = true;
      response.flush("final");
      assistant.text = assistant.pendingFinalText || assistant.text;
      trace.finish(assistant.text);
      completeTaskRun(key, {
        runId,
        quoteCitations: assistant.quoteCitations,
      });
      await trace.persist(key, generation, "completed");
      assistant.streaming = false;
      // Stored like a real turn, so the conversation can be reopened.
      await appendMessage(key, user);
      await appendMessage(key, {
        ...assistant,
        pendingAgentTraceEvents: undefined,
      } as Message);
      response.dispose();
      trace.dispose();
      finishRequest(key, requestId);
      refreshChat(body, item);
      await Zotero.Promise.delay(100);
    },
  };
}

// ---------------------------------------------------------------------------
// A stored conversation, reopened after a restart
// ---------------------------------------------------------------------------

export type TaskProgressStoredTurn = {
  /** The run's id; generated when absent. */
  runId?: string;
  user: Partial<Message> & { text: string };
  answer: string;
  quoteCitations?: Message["quoteCitations"];
  /** The run's persisted events (paper ledger updates, a plan, …). */
  events: AgentEvent[];
};

/** Store turns as a real conversation: messages and each run's trace. */
export async function seedTaskProgressConversation(
  panel: Panel,
  turns: TaskProgressStoredTurn[],
): Promise<{ conversationKey: number; runIds: string[] }> {
  const key = getConversationKey(panel.item);
  const runIds: string[] = [];
  let timestamp = Date.now();
  for (const turn of turns) {
    const runId = turn.runId || `task-progress-stored-${timestamp}`;
    runIds.push(runId);
    const user = {
      role: "user" as const,
      timestamp: timestamp++,
      ...turn.user,
    };
    const assistant = {
      role: "assistant" as const,
      text: turn.answer,
      timestamp: timestamp++,
      runMode: "agent" as const,
      agentRunId: runId,
      quoteCitations: turn.quoteCitations,
    };
    await appendMessage(key, user);
    await appendMessage(key, assistant);
    const records: AgentRunEventRecord[] = turn.events.map((event, index) => ({
      runId,
      seq: index + 1,
      eventType: event.type,
      payload: event,
      createdAt: assistant.timestamp,
    }));
    await saveAgentRunTraceSnapshot(
      {
        runId,
        conversationKey: key,
        mode: "agent",
        status: "completed",
        createdAt: user.timestamp,
        completedAt: assistant.timestamp,
        finalText: turn.answer,
      },
      records,
    );
  }
  return { conversationKey: key, runIds };
}

/**
 * What a restart leaves: no Task progress record and no loaded messages.
 * The panel then loads the conversation from disk and syncs, as it does
 * when a conversation is shown again, and the record is rebuilt.
 */
/**
 * Put papers, folders and tags in a panel's context bar, as the @ picker or a
 * drop does, and redraw the bar (Task progress follows it).
 */
export async function setTaskProgressComposerContexts(
  panel: Panel,
  input: {
    paperContexts?: import("../../shared/types").PaperContextRef[];
    collectionContexts?: import("../../shared/types").CollectionContextRef[];
    tagContexts?: import("../../shared/types").TagContextRef[];
  },
): Promise<void> {
  const { body, item } = panel;
  const copy = <T>(list: T[] | undefined) => (list ? [...list] : undefined);
  composeContextStore.papers.replace(item.id, copy(input.paperContexts));
  composeContextStore.collections.replace(
    item.id,
    copy(input.collectionContexts),
  );
  composeContextStore.tags.replace(item.id, copy(input.tagContexts));
  composeContextStore.initializedConversations.mark(item.id);
  // The panel state too: the chips redraw, and Task progress follows them
  // through the same sync a chip added by hand goes through.
  refreshConversationPanels(body, item, { includePanelState: true });
  await Zotero.Promise.delay(50);
  flushTaskProgressPanels();
}

/** What a panel's context bar holds (item ids and folder/tag exclusions). */
export function readTaskProgressComposerContexts(panel: Panel) {
  const id = panel.item.id;
  return {
    paperItemIds: composeContextStore.papers
      .list(id)
      .map((paper) => paper.itemId),
    collections: composeContextStore.collections.list(id).map((collection) => ({
      collectionId: collection.collectionId,
      excludedItemIds: collection.excludedItemIds || [],
    })),
    chipLabels: Array.from(
      panel.body.querySelectorAll(
        ".llm-collection-chip-title, .llm-tag-chip-title",
      ),
    ).map((node) => (node as Element).textContent || ""),
  };
}

export async function reopenTaskProgressConversation(
  panel: Panel,
): Promise<void> {
  const { body, item } = panel;
  const key = getConversationKey(item);
  for (const message of chatHistory.get(key) || []) {
    if (message.agentRunId) agentRunTraceCache.delete(message.agentRunId);
  }
  clearTaskProgress(key);
  chatHistory.delete(key);
  loadedConversationKeys.delete(key);
  // A restart starts with an empty context bar; the composer then sets it up
  // again from the conversation's history.
  composeContextStore.papers.delete(key);
  composeContextStore.collections.delete(key);
  composeContextStore.tags.delete(key);
  composeContextStore.initializedConversations.forget(key);
  await ensureConversationLoaded(item);
  refreshChat(body, item);
  flushTaskProgressPanels();
  await waitForTaskProgressHydrationForTests(key);
  await Zotero.Promise.delay(50);
  flushTaskProgressPanels();
}
