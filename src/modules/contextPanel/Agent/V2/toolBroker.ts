import {
  createAgentToolExecutorState,
  executeAgentToolCall,
} from "../Tools/executor";
import { getAgentToolDefinitions } from "../Tools/registry";
import type {
  AgentToolCall,
  AgentToolExecutionResult,
  AgentToolExecutorState,
  AgentToolName,
} from "../Tools/types";
import type {
  AgentV2ToolBrokerParams,
  ToolExecutionOutcome,
  ToolSpecV2,
  UiActionDirective,
} from "./types";

function buildToolInputSchema(name: AgentToolName): Record<string, unknown> {
  switch (name) {
    case "list_papers":
      return {
        type: "object",
        properties: {
          name: { const: "list_papers" },
          query: { type: "string", description: "optional search terms" },
          limit: { type: "integer", minimum: 1, maximum: 12, default: 6 },
        },
        required: ["name"],
        additionalProperties: false,
      };
    case "search_internet":
      return {
        type: "object",
        properties: {
          name: { const: "search_internet" },
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 6 },
        },
        required: ["name", "query"],
        additionalProperties: false,
      };
    case "search_paper_content":
      return {
        type: "object",
        properties: {
          name: { const: "search_paper_content" },
          target: {
            type: "object",
            properties: {
              scope: { type: "string" },
              index: { type: "integer", minimum: 1 },
            },
            required: ["scope"],
            additionalProperties: false,
          },
          query: { type: "string", minLength: 1 },
        },
        required: ["name", "target", "query"],
        additionalProperties: false,
      };
    default:
      return {
        type: "object",
        properties: {
          name: { const: name },
          target: {
            type: "object",
            properties: {
              scope: { type: "string" },
              index: { type: "integer", minimum: 1 },
            },
            required: ["scope"],
            additionalProperties: false,
          },
        },
        required: ["name", "target"],
        additionalProperties: false,
      };
  }
}

function buildErrorResult(call: AgentToolCall, message: string): AgentToolExecutionResult {
  return {
    name: call.name,
    targetLabel: call.target ? call.target.scope : call.name,
    ok: false,
    traceLines: [message],
    groundingText: "",
    addedPaperContexts: [],
    estimatedTokens: 0,
    truncated: false,
  };
}

function buildUiActionDirective(result: AgentToolExecutionResult): UiActionDirective | null {
  if (result.name === "write_note") {
    return {
      type: "show_note_review",
      targetLabel: result.targetLabel,
      message:
        "A note draft is ready in the review panel. Please review and click Save to Zotero.",
    };
  }
  if (result.name === "fix_metadata") {
    return {
      type: "show_metadata_review",
      targetLabel: result.targetLabel,
      message:
        "Metadata suggestions are ready in the review panel. Please review and click Accept.",
    };
  }
  return null;
}

let cachedToolSpecs: ToolSpecV2[] | null = null;

export function getToolSpecsV2(): ToolSpecV2[] {
  if (cachedToolSpecs) {
    return cachedToolSpecs;
  }

  cachedToolSpecs = getAgentToolDefinitions().map((definition) => ({
    name: definition.name,
    description: definition.plannerDescription,
    inputSchema: buildToolInputSchema(definition.name),
    callExample: definition.callExample,
    validate: definition.validate,
  }));

  return cachedToolSpecs;
}

export function resetToolSpecsV2Cache(): void {
  cachedToolSpecs = null;
}

export function createAgentV2ToolBrokerState(): AgentToolExecutorState {
  return createAgentToolExecutorState();
}

export function createToolBrokerExecutor(deps?: {
  executeCall?: typeof executeAgentToolCall;
}): (params: AgentV2ToolBrokerParams) => Promise<ToolExecutionOutcome> {
  const executeCall = deps?.executeCall || executeAgentToolCall;

  return async (params: AgentV2ToolBrokerParams): Promise<ToolExecutionOutcome> => {
    const specs = getToolSpecsV2();
    const spec = specs.find((entry) => entry.name === params.call.name);
    if (!spec) {
      const result = buildErrorResult(
        params.call,
        `Unknown tool call was ignored: ${params.call.name}.`,
      );
      return {
        kind: "error",
        result,
        error: result.traceLines[0] || "Unknown tool call.",
      };
    }

    const validatedCall = spec.validate(params.call);
    if (!validatedCall) {
      const result = buildErrorResult(
        params.call,
        `Malformed tool call was ignored: ${params.call.name}.`,
      );
      return {
        kind: "error",
        result,
        error: result.traceLines[0] || "Malformed tool call.",
      };
    }

    const result = await executeCall({
      call: validatedCall,
      ctx: params.ctx,
      state: params.state,
    });

    if (!result) {
      const fallback = buildErrorResult(
        validatedCall,
        "Tool execution returned no result.",
      );
      return {
        kind: "error",
        result: fallback,
        error: fallback.traceLines[0] || "Tool execution returned no result.",
      };
    }

    if (!result.ok) {
      return {
        kind: "error",
        result,
        error: result.traceLines[0] || `${result.name} failed.`,
      };
    }

    const action = buildUiActionDirective(result);
    if (action) {
      return {
        kind: "ui_action",
        result,
        action,
      };
    }

    return {
      kind: "context_update",
      result,
    };
  };
}

export const executeToolViaBroker = createToolBrokerExecutor();
