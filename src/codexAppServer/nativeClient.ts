import type {
  ChatMessage,
  MessageContent,
  ReasoningConfig,
  ReasoningEvent,
  TextContent,
  UsageStats,
} from "../shared/llm";
import type { CodexConversationKind } from "../shared/types";
import {
  buildLegacyCodexAppServerChatInput,
  prepareCodexAppServerChatTurn,
} from "../utils/codexAppServerInput";
import {
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
  resolveCodexAppServerReasoningParams,
  resolveCodexAppServerTurnInputWithFallback,
  waitForCodexAppServerTurnCompletion,
  type CodexAppServerItemEvent,
  type CodexAppServerProcess,
} from "../utils/codexAppServerProcess";
import {
  getCodexConversationSummary,
  upsertCodexConversationSummary,
} from "./store";

export const CODEX_APP_SERVER_NATIVE_PROCESS_KEY = "codex_app_server_native";
const CODEX_APP_SERVER_SERVICE_NAME = "llm_for_zotero";

export type CodexNativeConversationScope = {
  conversationKey: number;
  libraryID: number;
  kind: CodexConversationKind;
  paperItemID?: number;
  title?: string;
};

export type CodexNativeStoreHooks = {
  loadProviderSessionId?: () => Promise<string | undefined>;
  persistProviderSessionId?: (threadId: string) => Promise<void>;
};

export type CodexNativeTurnResult = {
  text: string;
  threadId: string;
  resumed: boolean;
};

type NativeThreadResolution = {
  threadId: string;
  resumed: boolean;
};

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function extractSystemText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string" ? message.content.trim() : "",
    )
    .filter(Boolean)
    .join("\n\n");
}

function prefixUserContentWithContext(
  content: MessageContent,
  context: string,
): MessageContent {
  const prefix = context.trim();
  if (!prefix) return content;
  const textPrefix = `Zotero context for this turn:\n${prefix}\n\nUser request:\n`;
  if (typeof content === "string") {
    return `${textPrefix}${content}`;
  }
  let didPrefix = false;
  const nextParts = content.map((part) => {
    if (didPrefix || part.type !== "text") return part;
    didPrefix = true;
    return {
      ...part,
      text: `${textPrefix}${part.text || ""}`,
    } satisfies TextContent;
  });
  if (didPrefix) return nextParts;
  return [{ type: "text", text: prefix }, ...content];
}

function buildNativeMessages(params: {
  messages: ChatMessage[];
  includeVisibleHistory: boolean;
}): ChatMessage[] {
  const systemText = extractSystemText(params.messages);
  const visibleMessages = params.messages.filter(
    (message) => message.role !== "system",
  );
  let latestUserIndex = -1;
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    if (visibleMessages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return [
      {
        role: "user",
        content: systemText || "",
      },
    ];
  }

  const history = params.includeVisibleHistory
    ? visibleMessages.slice(0, latestUserIndex)
    : [];
  const latestUser = visibleMessages[latestUserIndex]!;
  return [
    ...history,
    {
      ...latestUser,
      content: prefixUserContentWithContext(latestUser.content, systemText),
    },
  ];
}

async function loadStoredProviderSessionId(params: {
  conversationKey: number;
  hooks?: CodexNativeStoreHooks;
}): Promise<string> {
  if (params.hooks?.loadProviderSessionId) {
    return normalizeNonEmptyString(await params.hooks.loadProviderSessionId());
  }
  const summary = await getCodexConversationSummary(params.conversationKey);
  return normalizeNonEmptyString(summary?.providerSessionId);
}

async function persistProviderSessionId(params: {
  scope: CodexNativeConversationScope;
  threadId: string;
  model: string;
  effort?: string;
  hooks?: CodexNativeStoreHooks;
}): Promise<void> {
  await params.hooks?.persistProviderSessionId?.(params.threadId);
  if (params.hooks?.persistProviderSessionId) return;
  await upsertCodexConversationSummary({
    conversationKey: params.scope.conversationKey,
    libraryID: params.scope.libraryID,
    kind: params.scope.kind,
    paperItemID: params.scope.paperItemID,
    title: params.scope.title,
    providerSessionId: params.threadId,
    model: params.model,
    effort: params.effort,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function startNativeThread(params: {
  proc: CodexAppServerProcess;
  model: string;
}): Promise<string> {
  const threadResult = await params.proc.sendRequest("thread/start", {
    model: params.model,
    ephemeral: false,
    approvalPolicy: "never",
    serviceName: CODEX_APP_SERVER_SERVICE_NAME,
  });
  const threadId = extractCodexAppServerThreadId(threadResult);
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread ID");
  }
  return threadId;
}

async function resumeNativeThread(params: {
  proc: CodexAppServerProcess;
  threadId: string;
  model: string;
}): Promise<string> {
  const threadResult = await params.proc.sendRequest("thread/resume", {
    threadId: params.threadId,
    model: params.model,
    serviceName: CODEX_APP_SERVER_SERVICE_NAME,
  });
  const threadId = extractCodexAppServerThreadId(threadResult);
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread ID");
  }
  return threadId;
}

async function resolveNativeThread(params: {
  proc: CodexAppServerProcess;
  scope: CodexNativeConversationScope;
  model: string;
  effort?: string;
  hooks?: CodexNativeStoreHooks;
}): Promise<NativeThreadResolution> {
  const storedThreadId = await loadStoredProviderSessionId({
    conversationKey: params.scope.conversationKey,
    hooks: params.hooks,
  });
  if (storedThreadId) {
    try {
      const resumedThreadId = await resumeNativeThread({
        proc: params.proc,
        threadId: storedThreadId,
        model: params.model,
      });
      return { threadId: resumedThreadId, resumed: true };
    } catch (error) {
      ztoolkit.log(
        "Codex app-server native: thread/resume failed; starting a new persistent thread",
        error,
      );
    }
  }

  const threadId = await startNativeThread({
    proc: params.proc,
    model: params.model,
  });
  await persistProviderSessionId({
    scope: params.scope,
    threadId,
    model: params.model,
    effort: params.effort,
    hooks: params.hooks,
  });
  return { threadId, resumed: false };
}

export async function listCodexAppServerModels(params: {
  codexPath?: string;
  includeHidden?: boolean;
  processKey?: string;
} = {}): Promise<unknown> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  return proc.sendRequest("model/list", {
    includeHidden: params.includeHidden === true,
  });
}

export async function forkCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<string> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  const result = await proc.sendRequest("thread/fork", {
    threadId: params.threadId,
  });
  const threadId = extractCodexAppServerThreadId(result);
  if (!threadId) throw new Error("Codex app-server did not return a thread ID");
  return threadId;
}

export async function archiveCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/archive", { threadId: params.threadId });
}

export async function setCodexAppServerThreadName(params: {
  threadId: string;
  name: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const name = params.name.trim();
  if (!name) return;
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/name/set", {
    threadId: params.threadId,
    name: name.slice(0, 120),
  });
}

export async function compactCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/compact/start", {
    threadId: params.threadId,
  });
}

export async function runCodexAppServerNativeTurn(params: {
  scope: CodexNativeConversationScope;
  model: string;
  messages: ChatMessage[];
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
  codexPath?: string;
  processKey?: string;
  hooks?: CodexNativeStoreHooks;
  onDelta?: (delta: string) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
  onItemStarted?: (event: CodexAppServerItemEvent) => void;
  onItemCompleted?: (event: CodexAppServerItemEvent) => void;
  onTurnCompleted?: (event: { turnId: string; status?: string }) => void;
}): Promise<CodexNativeTurnResult> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const processKey = params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY;
  const proc = await getOrCreateCodexAppServerProcess(processKey, {
    codexPath,
  });
  return proc.runTurnExclusive(async () => {
    const reasoningParams = resolveCodexAppServerReasoningParams(
      params.reasoning,
      params.model,
    );
    const thread = await resolveNativeThread({
      proc,
      scope: params.scope,
      model: params.model,
      effort: reasoningParams.effort,
      hooks: params.hooks,
    });
    const nativeMessages = buildNativeMessages({
      messages: params.messages,
      includeVisibleHistory: !thread.resumed,
    });
    const preparedTurn = await prepareCodexAppServerChatTurn(nativeMessages);
    const input = await resolveCodexAppServerTurnInputWithFallback({
      proc,
      threadId: thread.threadId,
      historyItemsToInject: thread.resumed ? [] : preparedTurn.historyItemsToInject,
      turnInput: preparedTurn.turnInput,
      legacyInputFactory: () => buildLegacyCodexAppServerChatInput(nativeMessages),
      logContext: "native",
    });
    const turnResult = await proc.sendRequest("turn/start", {
      threadId: thread.threadId,
      input,
      model: params.model,
      approvalPolicy: "never",
      ...reasoningParams,
    });
    const turnId = extractCodexAppServerTurnId(turnResult);
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn ID");
    }
    const text = await waitForCodexAppServerTurnCompletion({
      proc,
      threadId: thread.threadId,
      turnId,
      onTextDelta: params.onDelta,
      onReasoning: params.onReasoning,
      onUsage: params.onUsage,
      onItemStarted: params.onItemStarted,
      onItemCompleted: params.onItemCompleted,
      onTurnCompleted: params.onTurnCompleted,
      signal: params.signal,
      interruptOnAbort: true,
      cacheKey: processKey,
      processOptions: { codexPath },
    });
    return {
      text,
      threadId: thread.threadId,
      resumed: thread.resumed,
    };
  });
}
