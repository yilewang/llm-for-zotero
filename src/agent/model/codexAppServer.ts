import type {
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentModelStep,
  AgentToolCall,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import {
  destroyCachedCodexAppServerProcess,
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  isCodexAppServerThreadStartInstructionsUnsupportedError,
  resolveCodexAppServerTurnInputWithFallback,
  resolveCodexAppServerReasoningParams,
  waitForCodexAppServerTurnCompletion,
} from "../../utils/codexAppServerProcess";
import {
  buildLegacyCodexAppServerAgentInitialInput,
  extractLatestCodexAppServerUserInput,
  prepareCodexAppServerAgentTurn,
} from "../../utils/codexAppServerInput";
import { isMultimodalRequestSupported } from "./messageBuilder";

export function shouldResetCodexAppServerThreadOnError(
  error: unknown,
): boolean {
  if ((error as { name?: unknown } | null | undefined)?.name === "AbortError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(
      "Timed out waiting for codex app-server turn completion",
    ) ||
    message.includes("Timed out waiting for codex app-server response") ||
    message.includes("CodexAppServerProcess destroyed") ||
    message.includes("codex app-server process closed unexpectedly") ||
    message.includes("Codex app-server did not return a thread ID") ||
    message.includes("Codex app-server did not return a turn ID")
  );
}

export class CodexAppServerAdapter implements AgentModelAdapter {
  private threadId: string | null = null;
  private processKey: string;

  constructor(processKey = "default") {
    this.processKey = processKey;
  }

  getCapabilities(_request: AgentRuntimeRequest): AgentModelCapabilities {
    return {
      streaming: true,
      toolCalls: true,
      multimodal: isMultimodalRequestSupported(_request),
      fileInputs: false,
      reasoning: true,
    };
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    return true;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const proc = await getOrCreateCodexAppServerProcess(this.processKey);
    let text: string;
    try {
      text = await proc.runTurnExclusive(async () => {
        let activeTurnId = "";
        const unregisterToolCallHandler = proc.onRequest(
          "item/tool/call",
          async (rawParams: unknown) => {
            const notification = rawParams as {
              callId?: unknown;
              turnId?: unknown;
              tool?: unknown;
              arguments?: unknown;
            };
            const requestTurnId =
              typeof notification.turnId === "string" &&
              notification.turnId.trim()
                ? notification.turnId.trim()
                : "";
            if (
              activeTurnId &&
              requestTurnId &&
              requestTurnId !== activeTurnId
            ) {
              return {
                contentItems: [
                  {
                    type: "inputText" as const,
                    text: "Ignoring stale tool call for an inactive app-server turn.",
                  },
                ],
                success: false,
              };
            }
            const call: AgentToolCall = {
              id:
                typeof notification.callId === "string" &&
                notification.callId.trim()
                  ? notification.callId
                  : `codex-app-server-${Date.now()}`,
              name:
                typeof notification.tool === "string"
                  ? notification.tool
                  : "unknown_tool",
              arguments: notification.arguments,
            };
            if (!params.onToolCall) {
              return {
                contentItems: [
                  {
                    type: "inputText" as const,
                    text: "Tool callbacks are unavailable for this request.",
                  },
                ],
                success: false,
              };
            }
            return params.onToolCall(call);
          },
        );
        try {
          const isFirstTurn = !this.threadId;
          const preparedTurn = isFirstTurn
            ? await prepareCodexAppServerAgentTurn(params.messages)
            : null;
          let shouldUseLegacyFirstTurnInput = false;
          if (isFirstTurn) {
            const threadStartParams: Record<string, unknown> = {
              model: request.model,
              ephemeral: true,
              approvalPolicy: "never",
              dynamicTools: params.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            };
            if (preparedTurn?.developerInstructions) {
              threadStartParams.developerInstructions =
                preparedTurn.developerInstructions;
            }
            let threadResp: unknown;
            try {
              threadResp = await proc.sendRequest(
                "thread/start",
                threadStartParams,
              );
            } catch (error) {
              if (
                !preparedTurn?.developerInstructions ||
                !isCodexAppServerThreadStartInstructionsUnsupportedError(error)
              ) {
                throw error;
              }
              shouldUseLegacyFirstTurnInput = true;
              const fallbackParams = { ...threadStartParams };
              delete fallbackParams.developerInstructions;
              ztoolkit.log(
                "Codex app-server: thread/start developerInstructions unsupported; using legacy flattened input",
              );
              threadResp = await proc.sendRequest(
                "thread/start",
                fallbackParams,
              );
            }
            this.threadId = extractCodexAppServerThreadId(threadResp);
            if (!this.threadId) {
              throw new Error("Codex app-server did not return a thread ID");
            }
          }
          const activeThreadId = this.threadId;
          if (!activeThreadId) {
            throw new Error("Codex app-server thread is not initialized");
          }
          const userInput = preparedTurn
            ? shouldUseLegacyFirstTurnInput
              ? await buildLegacyCodexAppServerAgentInitialInput(
                  params.messages,
                )
              : await resolveCodexAppServerTurnInputWithFallback({
                  proc,
                  threadId: activeThreadId,
                  historyItemsToInject: preparedTurn.historyItemsToInject,
                  turnInput: preparedTurn.turnInput,
                  legacyInputFactory: () =>
                    buildLegacyCodexAppServerAgentInitialInput(
                      params.messages,
                      {
                        includeSystem: !preparedTurn.developerInstructions,
                      },
                    ),
                  logContext: "agent-first-turn",
                })
            : await extractLatestCodexAppServerUserInput(params.messages);

          const turnResp = await proc.sendRequest("turn/start", {
            threadId: activeThreadId,
            input: userInput,
            model: request.model,
            ...resolveCodexAppServerReasoningParams(
              request.reasoning,
              request.model,
            ),
          });
          const turnId = extractCodexAppServerTurnId(turnResp);
          if (!turnId) {
            throw new Error("Codex app-server did not return a turn ID");
          }
          activeTurnId = turnId;

          return await waitForCodexAppServerTurnCompletion({
            proc,
            turnId,
            onTextDelta: params.onTextDelta,
            onReasoning: params.onReasoning,
            onUsage: params.onUsage,
            signal: params.signal,
            cacheKey: this.processKey,
          });
        } finally {
          unregisterToolCallHandler();
        }
      });
    } catch (error) {
      if (shouldResetCodexAppServerThreadOnError(error)) {
        this.threadId = null;
        destroyCachedCodexAppServerProcess(this.processKey, proc);
      }
      throw error;
    }

    const assistantMessage = { role: "assistant" as const, content: text };
    return { kind: "final", text, assistantMessage };
  }
}
