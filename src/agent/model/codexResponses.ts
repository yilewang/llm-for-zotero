import {
  buildReasoningPayload,
  buildPromptCachePayloadHints,
  isCodexFetchTransportError,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import type { ChatMessage, MessageContent } from "../../shared/llm";
import { getCodexBinaryPathPref } from "../../codexAppServer/prefs";
import { runCodexAuthAppServerTurn } from "../../utils/codexAuthAppServerTransport";
import {
  addZoteroMcpToolActivityObserver,
  buildZoteroMcpConfigValue,
  getZoteroMcpServerName,
  registerScopedZoteroMcpScope,
  type ZoteroMcpToolActivityEvent,
} from "../mcp/server";
import { normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentModelStep,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { buildAgentModelCapabilities } from "./contentCapabilities";
import {
  resolveRequestContentInputs,
  stringifyMessageContent,
} from "./messageBuilder";
import {
  buildResponsesContinuationInput,
  buildResponsesInitialInput,
  limitNormalizedResponsesStep,
  type ResponsesPayload,
  normalizeResponsesStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";
import {
  buildResponsesFunctionTools,
  getToolContinuationMessages,
} from "./shared";

function isCodexAuthRequest(request: AgentRuntimeRequest): boolean {
  return (
    request.authMode === "codex_auth" ||
    /chatgpt\.com\/backend-api\/codex\/responses/i.test(
      (request.apiBase || "").trim(),
    )
  );
}

type CodexAppServerTurnRunner = typeof runCodexAuthAppServerTurn;

function prepareCodexAgentFallbackMcpServer(
  request: AgentRuntimeRequest,
): import("../../utils/codexAuthAppServerTransport").CodexTurnMcpServer | undefined {
  // Unit tests and non-Zotero consumers can exercise the transport adapter
  // without constructing the local MCP endpoint.
  if (typeof Zotero === "undefined") return undefined;
  const selectedPaper =
    request.selectedPaperContexts?.[0] ||
    request.fullTextPaperContexts?.[0] ||
    request.pinnedPaperContexts?.[0] ||
    request.pdfPaperContexts?.[0];
  const kind = request.conversationKind === "paper" ? "paper" : "global";
  const fallbackActiveItemId = request.activeItemId || request.item?.id;
  const paperItemID =
    kind === "paper"
      ? selectedPaper?.itemId || fallbackActiveItemId
      : undefined;
  const scopedMcp = registerScopedZoteroMcpScope({
    conversationKey: request.conversationKey,
    conversationGeneration: request.conversationGeneration,
    libraryID: request.libraryID,
    kind,
    paperItemID,
    activeItemId: paperItemID || fallbackActiveItemId,
    activeContextItemId: selectedPaper?.contextItemId,
    title:
      selectedPaper?.title ||
      (request.item && typeof request.item.getField === "function"
        ? String(request.item.getField("title") || "")
        : undefined),
    userText: request.userText,
    model: request.model,
    codexPath: getCodexBinaryPathPref(),
    reasoning: request.reasoning,
    exhaustiveReadBackend: "codex_responses",
    paperContext: selectedPaper,
    selectedPaperContexts: request.selectedPaperContexts,
    pdfPaperContexts: request.pdfPaperContexts,
    fullTextPaperContexts: request.fullTextPaperContexts,
    pinnedPaperContexts: request.pinnedPaperContexts,
    selectedCollectionContexts: request.selectedCollectionContexts,
    selectedTagContexts: request.selectedTagContexts,
  });
  return {
    serverName: getZoteroMcpServerName(),
    configValue: buildZoteroMcpConfigValue({
      scopeToken: scopedMcp.token,
      required: true,
    }),
    clear: scopedMcp.clear,
  };
}

export function buildCodexFallbackMcpToolActivityEvent(
  event: ZoteroMcpToolActivityEvent,
): Extract<import("../types").AgentEvent, { type: "codex_tool_activity" }> {
  return {
    type: "codex_tool_activity",
    itemId: `mcp:${event.requestId || `${event.toolName}:${event.timestamp}`}`,
    phase: event.phase,
    toolName: event.toolName,
    toolLabel: event.toolLabel,
    serverName: event.serverName,
    args: event.arguments,
    ok: event.ok,
    text: event.error,
    artifacts: event.artifacts,
  };
}

function toAppServerContent(
  content: import("../types").AgentModelMessage["content"],
): MessageContent {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "image_url"
      ? part
      : {
          type: "text" as const,
          text:
            part.type === "text"
              ? part.text
              : `[Prepared file: ${part.file_ref.name}]`,
        },
  );
}

/**
 * The app-server transport accepts chat messages rather than the Agent
 * runtime's tool-role transcript. Preserve tool evidence as explicit text so
 * a Gecko fetch failure can be retried without losing the current turn.
 */
export function buildCodexAgentAppServerMessages(
  messages: import("../types").AgentModelMessage[],
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content:
          `[Tool result: ${message.name}, call_id=${message.tool_call_id}]\n` +
          message.content,
      };
    }

    let content = toAppServerContent(message.content);
    if (message.role === "assistant" && message.tool_calls?.length) {
      const toolCalls = message.tool_calls
        .map(
          (call) =>
            `[Tool call: ${call.name}, call_id=${call.id}]\n${JSON.stringify(call.arguments)}`,
        )
        .join("\n");
      const text = stringifyMessageContent(message.content);
      content = [text, toolCalls].filter(Boolean).join("\n");
    }
    return { role: message.role, content };
  });
}

export {
  limitNormalizedResponsesStep,
  normalizeResponsesStepFromPayload as normalizeStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";

export class CodexResponsesAgentAdapter implements AgentModelAdapter {
  private conversationItems: unknown[] | null = null;

  constructor(
    private readonly runAppServerTurn: CodexAppServerTurnRunner = runCodexAuthAppServerTurn,
  ) {}

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return buildAgentModelCapabilities({
      streaming: true,
      toolCalls: isCodexAuthRequest(request),
      contentInputs: resolveRequestContentInputs(request),
      fileInputs: false,
      reasoning: true,
    });
  }

  supportsTools(request: AgentRuntimeRequest): boolean {
    return this.getCapabilities(request).toolCalls;
  }

  resetState(): void {
    this.conversationItems = null;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const auth = await resolveRequestAuthState({
      authMode: request.authMode || "api_key",
      apiKey: request.apiKey || "",
      signal: params.signal,
    });
    const initialInput = await buildResponsesInitialInput(params.messages, {
      resolveFilePart: async (part) => [
        {
          type: "input_text" as const,
          text: `[Prepared file: ${part.file_ref.name}]`,
        },
      ],
      signal: params.signal,
    });
    const instructions =
      initialInput.instructions?.trim() ||
      "You are the agent runtime inside a Zotero plugin.";
    const followupInput = this.conversationItems
      ? await buildResponsesContinuationInput(
          getToolContinuationMessages(params.messages),
          {
            resolveFilePart: async (part) => [
              {
                type: "input_text" as const,
                text: `[Prepared file: ${part.file_ref.name}]`,
              },
            ],
            signal: params.signal,
          },
        )
      : [];
    const inputItems = this.conversationItems
      ? [...this.conversationItems, ...followupInput]
      : initialInput.input;
    const url = resolveProviderTransportEndpoint({
      protocol: "codex_responses",
      apiBase: request.apiBase || "",
    });
    let response: Response;
    try {
      response = await postWithReasoningFallback({
        url,
        auth,
        modelName: request.model,
        initialReasoning: request.reasoning,
        buildPayload: (reasoningOverride) => {
          const reasoningPayload = buildReasoningPayload(
            reasoningOverride,
            true,
            request.model,
            request.apiBase,
            "codex_responses",
          );
          return {
            model: request.model,
            instructions,
            input: inputItems,
            ...buildPromptCachePayloadHints(request.contextCache),
            include: ["reasoning.encrypted_content"],
            tools: buildResponsesFunctionTools(params.tools),
            tool_choice: "auto",
            store: false,
            stream: true,
            ...reasoningPayload.extra,
            ...(reasoningPayload.omitTemperature
              ? {}
              : {
                  temperature: normalizeTemperature(
                    request.advanced?.temperature,
                  ),
                }),
          };
        },
        signal: params.signal,
      });
    } catch (error) {
      if (!isCodexAuthRequest(request) || !isCodexFetchTransportError(error)) {
        throw error;
      }
      (
        globalThis as typeof globalThis & {
          ztoolkit?: { log?: (...args: unknown[]) => void };
        }
      ).ztoolkit?.log?.(
        "LLM Agent: Zotero fetch failed for Codex auth; retrying through local app-server",
        error,
      );
      const mcpServer = prepareCodexAgentFallbackMcpServer(request);
      let pendingMcpActivity = Promise.resolve();
      const unregisterMcpToolActivity = mcpServer
        ? addZoteroMcpToolActivityObserver((event) => {
            if (
              event.conversationKey &&
              event.conversationKey !== request.conversationKey
            ) {
              return;
            }
            pendingMcpActivity = pendingMcpActivity.then(async () => {
              try {
                await params.onCodexToolActivity?.(
                  buildCodexFallbackMcpToolActivityEvent(event),
                );
              } catch (activityError) {
                (
                  globalThis as typeof globalThis & {
                    ztoolkit?: { log?: (...args: unknown[]) => void };
                  }
                ).ztoolkit?.log?.(
                  "LLM Agent: failed to persist fallback MCP activity",
                  activityError,
                );
              }
            });
          })
        : () => undefined;
      let text: string;
      try {
        text = await this.runAppServerTurn({
          model: request.model || "",
          messages: buildCodexAgentAppServerMessages(params.messages),
          reasoning: request.reasoning,
          signal: params.signal,
          codexPath: getCodexBinaryPathPref(),
          onDelta: params.onTextDelta,
          onReasoning: params.onReasoning,
          onUsage: params.onUsage,
          mcpServer,
        });
      } finally {
        unregisterMcpToolActivity();
        await pendingMcpActivity;
      }
      // The fallback owns the complete turn, so any direct Responses state is
      // stale and must not be reused if Gecko fetch starts working later.
      this.resetState();
      return {
        kind: "final",
        text,
        assistantMessage: { role: "assistant", content: text },
      };
    }
    const normalized = limitNormalizedResponsesStep(
      response.body
        ? await parseResponsesStepStream(
            response.body,
            params.onTextDelta,
            params.onReasoning,
            params.onUsage,
          )
        : normalizeResponsesStepFromPayload(
            (await response.json()) as ResponsesPayload,
          ),
    );

    this.conversationItems = [...inputItems, ...normalized.outputItems];

    if (normalized.toolCalls.length) {
      return {
        kind: "tool_calls",
        calls: normalized.toolCalls,
        assistantMessage: {
          role: "assistant",
          content: normalized.text,
          tool_calls: normalized.toolCalls,
        },
      };
    }

    return {
      kind: "final",
      text: normalized.text,
      assistantMessage: {
        role: "assistant",
        content: normalized.text,
      },
    };
  }
}
