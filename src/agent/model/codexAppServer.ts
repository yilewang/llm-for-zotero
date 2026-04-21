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
  waitForCodexAppServerTurnCompletion,
} from "../../utils/codexAppServerProcess";
import {
  buildCodexAppServerAgentInitialInput,
  extractLatestCodexAppServerUserInput,
} from "../../utils/codexAppServerInput";
import { isMultimodalRequestSupported } from "./messageBuilder";

export function shouldResetCodexAppServerThreadOnError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Timed out waiting for codex app-server turn completion") ||
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
      reasoning: false,
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
        const unregisterToolCallHandler = proc.onRequest(
          "item/tool/call",
          async (rawParams: unknown) => {
            const notification = rawParams as {
              callId?: unknown;
              tool?: unknown;
              arguments?: unknown;
            };
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
          if (isFirstTurn) {
            const threadResp = await proc.sendRequest("thread/start", {
              model: request.model,
              approvalPolicy: "never",
              dynamicTools: params.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            });
            this.threadId = extractCodexAppServerThreadId(threadResp);
            if (!this.threadId) {
              throw new Error("Codex app-server did not return a thread ID");
            }
          }
          const userInput = isFirstTurn
            ? await buildCodexAppServerAgentInitialInput(params.messages)
            : await extractLatestCodexAppServerUserInput(params.messages);

          const turnResp = await proc.sendRequest("turn/start", {
            threadId: this.threadId,
            input: userInput,
          });
          const turnId = extractCodexAppServerTurnId(turnResp);
          if (!turnId) {
            throw new Error("Codex app-server did not return a turn ID");
          }

          return await waitForCodexAppServerTurnCompletion({
            proc,
            turnId,
            onTextDelta: params.onTextDelta,
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
