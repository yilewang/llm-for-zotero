/**
 * Native acceptance fixtures for the paper decision tools
 * (record_paper_decisions for the plugin's Agent, both tools over MCP).
 *
 * `exercisePaperDecisionsTurn`: one turn through the panel's real send flow
 * and the real runtime, with the real record_paper_decisions tool from the
 * built-in registry, its real Zotero lookups and the real trace and message stores. Only the
 * model is scripted: it makes the given tool calls in one step, then answers.
 *
 * `callScopedMcpToolForConversation`: one call through the plugin's own MCP
 * endpoint, under a scope for the panel's conversation, with the completed
 * activity a connected runtime's observer would receive.
 */
import { sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import { AgentRuntime } from "../../agent/runtime";
import { AgentToolRegistry } from "../../agent/tools/registry";
import { ActionContractService } from "../../agent/contracts/actionContract";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import { RECORD_PAPER_DECISIONS_TOOL_NAME } from "../../agent/tools/control/recordPaperDecisions";
import {
  addZoteroMcpToolActivityObserver,
  getOrCreateZoteroMcpBearerToken,
  registerScopedZoteroMcpScope,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../../agent/mcp/server";
import type { ZoteroMcpToolActivityEvent } from "../../agent/mcp/activityTypes";
import type { AgentEvent, AgentModelStep } from "../../agent/types";

export type PaperDecisionsTurnInput = {
  question: string;
  calls: Array<{ id: string; name: string; arguments: unknown }>;
  answer: string;
};

export type PaperDecisionsTurnResult = {
  conversationKey: number;
  runId: string;
  runStatus?: string;
  /** Each call's result content, by call id. */
  results: Record<string, unknown>;
  /** The run's stored events. */
  events: AgentEvent[];
};

export async function exercisePaperDecisionsTurn(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: PaperDecisionsTurnInput,
): Promise<PaperDecisionsTurnResult> {
  const { body, item } = panel;
  const key = getConversationKey(item);
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const builtIn = deps.getAgentRuntime();
  const registry = new AgentToolRegistry(
    new ActionContractService(new ZoteroGateway()),
  );
  // review_coverage is MCP-only; the plugin's own Agent does not list it.
  for (const name of [RECORD_PAPER_DECISIONS_TOOL_NAME]) {
    const tool = builtIn.getToolDefinition(name);
    if (!tool) throw new Error(`The built-in registry has no ${name}`);
    registry.register(tool);
  }
  let steps = 0;
  const runtime = new AgentRuntime({
    registry,
    adapterFactory: () => ({
      supportsTools: () => true,
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
        fileInputs: false,
        reasoning: false,
      }),
      runStep: async (): Promise<AgentModelStep> => {
        steps += 1;
        if (steps === 1 && input.calls.length) {
          return {
            kind: "tool_calls",
            calls: input.calls,
            assistantMessage: {
              role: "assistant",
              content: "",
              tool_calls: input.calls,
            },
          };
        }
        return {
          kind: "final",
          text: input.answer,
          assistantMessage: { role: "assistant", content: input.answer },
        };
      },
    }),
  });
  deps.getAgentRuntime = () => runtime;
  await sendAgentTurn(
    {
      body,
      item,
      question: input.question,
      advanced: { temperature: 0, outputTokenLimit: { mode: "auto" } },
    },
    deps,
  );
  const runId = deps.chatHistory.get(key)?.at(-1)?.agentRunId || "";
  const trace = await getAgentRunTrace(runId);
  const events = trace.events.map((event) => event.payload);
  const results: Record<string, unknown> = {};
  for (const event of events) {
    if (event.type === "tool_result") results[event.callId] = event.content;
  }
  return {
    conversationKey: key,
    runId,
    runStatus: trace.run?.status,
    results,
    events,
  };
}

/**
 * One tools/call through the plugin's MCP endpoint, under a scope token for
 * the panel's conversation and library with `runId` as the scope's run, as
 * a connected runtime's turn registers it. The scope names no runtime, so
 * the conversation is read from the panel's own (upstream) store. Returns
 * the tool's result and the call's completed activity.
 */
export async function callScopedMcpToolForConversation(
  panel: { item: Zotero.Item },
  input: { runId: string; name: string; arguments: unknown },
): Promise<{
  result: unknown;
  activity: ZoteroMcpToolActivityEvent | null;
}> {
  const conversationKey = getConversationKey(panel.item);
  const scope = registerScopedZoteroMcpScope({
    conversationKey,
    libraryID: panel.item.libraryID,
    kind: "paper",
    runId: input.runId,
  });
  const activities: ZoteroMcpToolActivityEvent[] = [];
  const unregister = addZoteroMcpToolActivityObserver((event) => {
    if (event.phase === "completed" && event.runId === input.runId)
      activities.push(event);
  });
  try {
    const Endpoint = (
      Zotero.Server.Endpoints as unknown as Record<
        string,
        new () => {
          init(request: unknown): Promise<[number, string, string]>;
        }
      >
    )[ZOTERO_MCP_ENDPOINT_PATH];
    if (!Endpoint) throw new Error("The Zotero MCP endpoint is not registered");
    const [status, , body] = await new Endpoint().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        [ZOTERO_MCP_SCOPE_HEADER]: scope.token,
      },
      data: {
        jsonrpc: "2.0",
        id: `paper-decisions-${Date.now()}`,
        method: "tools/call",
        params: { name: input.name, arguments: input.arguments },
      },
    });
    if (status !== 200) throw new Error(`MCP call failed: ${status} ${body}`);
    const payload = JSON.parse(body) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    if (payload.error) throw new Error(`MCP call failed: ${body}`);
    const text = payload.result?.content?.[0]?.text || "null";
    const parsed = JSON.parse(text) as { result?: unknown } | null;
    return {
      result: parsed && "result" in parsed ? parsed.result : parsed,
      activity: activities[0] || null,
    };
  } finally {
    unregister();
    scope.clear();
  }
}
