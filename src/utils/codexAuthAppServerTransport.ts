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
import { prepareLegacyCodexIsolatedEnvironment } from "./codexAuthIsolation";

export type CodexTurnMcpServer = {
  serverName: string;
  configValue: Record<string, unknown>;
  clear?: () => void;
};

// Legacy retries run in a separate app-server whose global MCP table is empty.
// Thread-level overrides are merged with global config by Codex, so they cannot
// reliably disable a large user MCP catalog after the process has started.
export const CODEX_SHARED_APP_SERVER_PROCESS_KEY =
  "codex_app_server_legacy_auth_isolated";
export const CODEX_LEGACY_APP_SERVER_CONFIG_OVERRIDES = [
  "mcp_servers={}",
  "skills.include_instructions=false",
  "skills.bundled.enabled=false",
  "features.shell_snapshot=false",
];

export async function runCodexAuthAppServerTurn(params: {
  model: string;
  messages: ChatMessage[];
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
  codexPath?: string;
  onDelta?: (delta: string) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
  /** Optional already-scoped MCP server exposed only to this isolated turn. */
  mcpServer?: CodexTurnMcpServer;
}): Promise<string> {
  const scopedMcp = params.mcpServer;
  try {
    const isolatedEnvironment =
      await prepareLegacyCodexIsolatedEnvironment();
    const processOptions = {
      codexPath: resolveCodexAppServerBinaryPath(params.codexPath),
      configOverrides: CODEX_LEGACY_APP_SERVER_CONFIG_OVERRIDES,
      environment: isolatedEnvironment,
    };
    const proc = await getOrCreateCodexAppServerProcess(
      CODEX_SHARED_APP_SERVER_PROCESS_KEY,
      processOptions,
    );

    return await proc.runTurnExclusive(async () => {
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
      ...(scopedMcp
        ? {
            config: {
              features: { shell_tool: false },
              mcp_servers: {
                [scopedMcp.serverName]: scopedMcp.configValue,
              },
            },
          }
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
  } finally {
    scopedMcp?.clear?.();
  }
}
