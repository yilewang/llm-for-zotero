import type {
  ChatMessage,
  ReasoningConfig,
  ReasoningEvent,
  UsageStats,
} from "../shared/llm";
import {
  buildLegacyCodexAppServerChatInput,
  prepareCodexAppServerChatTurn,
} from "./codexAppServerInput";
import {
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  isCodexAppServerThreadStartInstructionsUnsupportedError,
  resolveCodexAppServerBinaryPath,
  resolveCodexAppServerReasoningParams,
  resolveCodexAppServerTurnInputWithFallback,
  waitForCodexAppServerTurnCompletion,
} from "./codexAppServerProcess";

// Intentionally share the process used by the native Agent runtime. This lets
// the legacy provider recover from Gecko fetch failures without launching a
// second Codex runtime, and lets the Agent connection test warm the same
// process used by real turns.
export const CODEX_SHARED_APP_SERVER_PROCESS_KEY = "codex_app_server_native";

export async function runCodexAuthAppServerTurn(params: {
  model: string;
  messages: ChatMessage[];
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
  codexPath?: string;
  onDelta?: (delta: string) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
}): Promise<string> {
  const processOptions = {
    codexPath: resolveCodexAppServerBinaryPath(params.codexPath),
  };
  const proc = await getOrCreateCodexAppServerProcess(
    CODEX_SHARED_APP_SERVER_PROCESS_KEY,
    processOptions,
  );

  return proc.runTurnExclusive(async () => {
    const prepared = await prepareCodexAppServerChatTurn(params.messages);
    const threadStartParams: Record<string, unknown> = {
      model: params.model || undefined,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "llm_for_zotero",
      ...(prepared.developerInstructions
        ? { developerInstructions: prepared.developerInstructions }
        : {}),
    };

    let developerInstructionsAccepted = true;
    let threadResponse: unknown;
    try {
      threadResponse = await proc.sendRequest(
        "thread/start",
        threadStartParams,
      );
    } catch (error) {
      if (
        !prepared.developerInstructions ||
        !isCodexAppServerThreadStartInstructionsUnsupportedError(error)
      ) {
        throw error;
      }
      developerInstructionsAccepted = false;
      const fallbackParams = { ...threadStartParams };
      delete fallbackParams.developerInstructions;
      threadResponse = await proc.sendRequest("thread/start", fallbackParams);
    }

    const threadId = extractCodexAppServerThreadId(threadResponse);
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread ID");
    }

    const input = await resolveCodexAppServerTurnInputWithFallback({
      proc,
      threadId,
      historyItemsToInject: prepared.historyItemsToInject,
      turnInput: prepared.turnInput,
      legacyInputFactory: () =>
        buildLegacyCodexAppServerChatInput(params.messages, {
          includeSystem: !developerInstructionsAccepted,
        }),
      logContext: "legacy Codex auth transport",
    });
    const turnResponse = await proc.sendRequest("turn/start", {
      threadId,
      input,
      model: params.model || undefined,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...resolveCodexAppServerReasoningParams(params.reasoning, params.model),
    });
    const turnId = extractCodexAppServerTurnId(turnResponse);
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn ID");
    }

    return waitForCodexAppServerTurnCompletion({
      proc,
      threadId,
      turnId,
      onTextDelta: params.onDelta,
      onReasoning: params.onReasoning,
      onUsage: params.onUsage,
      signal: params.signal,
      interruptOnAbort: true,
      cacheKey: CODEX_SHARED_APP_SERVER_PROCESS_KEY,
      processOptions,
    });
  });
}
